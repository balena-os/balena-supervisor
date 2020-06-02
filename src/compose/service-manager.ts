import * as Bluebird from 'bluebird';
import * as Dockerode from 'dockerode';
import { EventEmitter } from 'events';
import { isLeft } from 'fp-ts/lib/Either';
import * as JSONStream from 'JSONStream';
import * as _ from 'lodash';
import { fs } from 'mz';
import StrictEventEmitter from 'strict-event-emitter-types';

import * as config from '../config';
import Docker from '../lib/docker-utils';
import Logger from '../logger';

import { PermissiveNumber } from '../config/types';
import constants = require('../lib/constants');
import {
	InternalInconsistencyError,
	NotFoundError,
	StatusCodeError,
} from '../lib/errors';
import * as LogTypes from '../lib/log-types';
import { checkInt, isValidDeviceName } from '../lib/validation';
import { Service } from './service';
import { serviceNetworksToDockerNetworks } from './utils';

import log from '../lib/supervisor-console';

interface ServiceConstructOpts {
	docker: Docker;
	logger: Logger;
}

interface ServiceManagerEvents {
	change: void;
}
type ServiceManagerEventEmitter = StrictEventEmitter<
	EventEmitter,
	ServiceManagerEvents
>;

interface KillOpts {
	removeContainer?: boolean;
	wait?: boolean;
}

export class ServiceManager extends (EventEmitter as new () => ServiceManagerEventEmitter) {
	private docker: Docker;
	private logger: Logger;

	// Whether a container has died, indexed by ID
	private containerHasDied: Dictionary<boolean> = {};
	private listening = false;
	// Volatile state of containers, indexed by containerId (or random strings if
	// we don't yet have an id)
	private volatileState: Dictionary<Partial<Service>> = {};

	public constructor(opts: ServiceConstructOpts) {
		super();
		this.docker = opts.docker;
		this.logger = opts.logger;
	}

	public async getAll(
		extraLabelFilters: string | string[] = [],
	): Promise<Service[]> {
		const filterLabels = ['supervised'].concat(extraLabelFilters);
		const containers = await this.listWithBothLabels(filterLabels);

		const services = await Bluebird.map(containers, async (container) => {
			try {
				const serviceInspect = await this.docker
					.getContainer(container.Id)
					.inspect();
				const service = Service.fromDockerContainer(serviceInspect);
				// We know that the containerId is set below, because `fromDockerContainer`
				// always sets it
				const vState = this.volatileState[service.containerId!];
				if (vState != null && vState.status != null) {
					service.status = vState.status;
				}
				return service;
			} catch (e) {
				if (NotFoundError(e)) {
					return null;
				}
				throw e;
			}
		});

		return services.filter((s) => s != null) as Service[];
	}

	public async get(service: Service) {
		// Get the container ids for special network handling
		const containerIds = await this.getContainerIdMap(service.appId!);
		const services = (
			await this.getAll(`service-id=${service.serviceId}`)
		).filter((currentService) =>
			currentService.isEqualConfig(service, containerIds),
		);

		if (services.length === 0) {
			const e: StatusCodeError = new Error(
				'Could not find a container matching this service definition',
			);
			e.statusCode = 404;
			throw e;
		}
		return services[0];
	}

	public async getStatus() {
		const services = await this.getAll();
		const status = _.clone(this.volatileState);

		for (const service of services) {
			if (service.containerId == null) {
				throw new InternalInconsistencyError(
					`containerId not defined in ServiceManager.getStatus: ${service}`,
				);
			}
			if (status[service.containerId] == null) {
				status[service.containerId] = _.pick(service, [
					'appId',
					'imageId',
					'status',
					'releaseId',
					'commit',
					'createdAt',
					'serviceName',
				]) as Partial<Service>;
			}
		}

		return _.values(status);
	}

	public async getByDockerContainerId(
		containerId: string,
	): Promise<Service | null> {
		const container = await this.docker.getContainer(containerId).inspect();
		if (
			container.Config.Labels['io.balena.supervised'] == null &&
			container.Config.Labels['io.resin.supervised'] == null
		) {
			return null;
		}
		return Service.fromDockerContainer(container);
	}

	public async updateMetadata(
		service: Service,
		metadata: { imageId: number; releaseId: number },
	) {
		const svc = await this.get(service);
		if (svc.containerId == null) {
			throw new InternalInconsistencyError(
				`No containerId provided for service ${service.serviceName} in ServiceManager.updateMetadata. Service: ${service}`,
			);
		}

		await this.docker.getContainer(svc.containerId).rename({
			name: `${service.serviceName}_${metadata.imageId}_${metadata.releaseId}`,
		});
	}

	public async handover(current: Service, target: Service) {
		// We set the running container to not restart so that in case of a poweroff
		// it doesn't come back after boot.
		await this.prepareForHandover(current);
		await this.start(target);
		await this.waitToKill(
			current,
			target.config.labels['io.balena.update.handover-timeout'],
		);
		await this.kill(current);
	}

	public async killAllLegacy(): Promise<void> {
		// Containers haven't been normalized (this is an updated supervisor)
		// so we need to stop and remove them
		const supervisorImageId = (
			await this.docker.getImage(constants.supervisorImage).inspect()
		).Id;

		for (const container of await this.docker.listContainers({ all: true })) {
			if (container.ImageID !== supervisorImageId) {
				await this.killContainer(container.Id, {
					serviceName: 'legacy',
				});
			}
		}
	}

	public kill(service: Service, opts: KillOpts = {}) {
		if (service.containerId == null) {
			throw new InternalInconsistencyError(
				`Attempt to kill container without containerId! Service :${service}`,
			);
		}
		return this.killContainer(service.containerId, service, opts);
	}

	public async remove(service: Service) {
		this.logger.logSystemEvent(LogTypes.removeDeadService, { service });
		const existingService = await this.get(service);

		if (existingService.containerId == null) {
			throw new InternalInconsistencyError(
				`No containerId provided for service ${service.serviceName} in ServiceManager.updateMetadata. Service: ${service}`,
			);
		}

		try {
			await this.docker
				.getContainer(existingService.containerId)
				.remove({ v: true });
		} catch (e) {
			if (!NotFoundError(e)) {
				this.logger.logSystemEvent(LogTypes.removeDeadServiceError, {
					service,
					error: e,
				});
				throw e;
			}
		}
	}
	public getAllByAppId(appId: number) {
		return this.getAll(`app-id=${appId}`);
	}

	public async stopAllByAppId(appId: number) {
		for (const app of await this.getAllByAppId(appId)) {
			await this.kill(app, { removeContainer: false });
		}
	}

	public async create(service: Service) {
		const mockContainerId = config.newUniqueKey();
		try {
			const existing = await this.get(service);
			if (existing.containerId == null) {
				throw new InternalInconsistencyError(
					`No containerId provided for service ${service.serviceName} in ServiceManager.updateMetadata. Service: ${service}`,
				);
			}
			return this.docker.getContainer(existing.containerId);
		} catch (e) {
			if (!NotFoundError(e)) {
				this.logger.logSystemEvent(LogTypes.installServiceError, {
					service,
					error: e,
				});
				throw e;
			}

			const deviceName = await config.get('name');
			if (!isValidDeviceName(deviceName)) {
				throw new Error(
					'The device name contains a newline, which is unsupported by balena. ' +
						'Please fix the device name',
				);
			}

			// Get all created services so far
			if (service.appId == null) {
				throw new InternalInconsistencyError(
					'Attempt to start a service without an existing application ID',
				);
			}
			const serviceContainerIds = await this.getContainerIdMap(service.appId);
			const conf = service.toDockerContainer({
				deviceName,
				containerIds: serviceContainerIds,
			});
			const nets = serviceNetworksToDockerNetworks(
				service.extraNetworksToJoin(),
			);

			this.logger.logSystemEvent(LogTypes.installService, { service });
			this.reportNewStatus(mockContainerId, service, 'Installing');

			const container = await this.docker.createContainer(conf);
			service.containerId = container.id;

			await Promise.all(
				_.map((nets || {}).EndpointsConfig, (endpointConfig, name) =>
					this.docker.getNetwork(name).connect({
						Container: container.id,
						EndpointConfig: endpointConfig,
					}),
				),
			);

			this.logger.logSystemEvent(LogTypes.installServiceSuccess, { service });
			return container;
		} finally {
			this.reportChange(mockContainerId);
		}
	}

	public async start(service: Service) {
		let alreadyStarted = false;
		let containerId: string | null = null;

		try {
			const container = await this.create(service);
			containerId = container.id;
			this.logger.logSystemEvent(LogTypes.startService, { service });

			this.reportNewStatus(containerId, service, 'Starting');

			let remove = false;
			let err: Error | undefined;
			try {
				await container.start();
			} catch (e) {
				// Get the statusCode from the original cause and make sure it's
				// definitely an int for comparison reasons
				const maybeStatusCode = PermissiveNumber.decode(e.statusCode);
				if (isLeft(maybeStatusCode)) {
					remove = true;
					err = new Error(
						`Could not parse status code from docker error:  ${e}`,
					);
					throw err;
				}
				const statusCode = maybeStatusCode.right;
				const message = e.message;

				// 304 means the container was already started, precisely what we want
				if (statusCode === 304) {
					alreadyStarted = true;
				} else if (
					statusCode === 500 &&
					_.isString(message) &&
					message.trim().match(/exec format error$/)
				) {
					// Provide a friendlier error message for "exec format error"
					const deviceType = await config.get('deviceType');
					err = new Error(
						`Application architecture incompatible with ${deviceType}: exec format error`,
					);
					throw err;
				} else {
					// rethrow the same error
					err = e;
					throw e;
				}
			} finally {
				if (remove) {
					// If starting the container fialed, we remove it so that it doesn't litter
					await container.remove({ v: true }).catch(_.noop);
					this.logger.logSystemEvent(LogTypes.startServiceError, {
						service,
						error: err,
					});
				}
			}

			const serviceId = service.serviceId;
			const imageId = service.imageId;
			if (serviceId == null || imageId == null) {
				throw new InternalInconsistencyError(
					`serviceId and imageId not defined for service: ${service.serviceName} in ServiceManager.start`,
				);
			}

			this.logger.attach(this.docker, container.id, { serviceId, imageId });

			if (!alreadyStarted) {
				this.logger.logSystemEvent(LogTypes.startServiceSuccess, { service });
			}

			service.config.running = true;
			return container;
		} finally {
			if (containerId != null) {
				this.reportChange(containerId);
			}
		}
	}

	public listenToEvents() {
		if (this.listening) {
			return;
		}

		this.listening = true;

		const listen = async () => {
			const stream = await this.docker.getEvents({
				// Remove the as any once
				// https://github.com/DefinitelyTyped/DefinitelyTyped/pull/43100
				// is merged and released
				filters: { type: ['container'] } as any,
			});

			stream.on('error', (e) => {
				log.error(`Error on docker events stream:`, e);
			});
			const parser = JSONStream.parse();
			parser.on('data', async (data: { status: string; id: string }) => {
				if (data != null) {
					const status = data.status;
					if (status === 'die' || status === 'start') {
						try {
							let service: Service | null = null;
							try {
								service = await this.getByDockerContainerId(data.id);
							} catch (e) {
								if (!NotFoundError(e)) {
									throw e;
								}
							}
							if (service != null) {
								this.emit('change');
								if (status === 'die') {
									this.logger.logSystemEvent(LogTypes.serviceExit, { service });
									this.containerHasDied[data.id] = true;
								} else if (
									status === 'start' &&
									this.containerHasDied[data.id]
								) {
									delete this.containerHasDied[data.id];
									this.logger.logSystemEvent(LogTypes.serviceRestart, {
										service,
									});

									const serviceId = service.serviceId;
									const imageId = service.imageId;
									if (serviceId == null || imageId == null) {
										throw new InternalInconsistencyError(
											`serviceId and imageId not defined for service: ${service.serviceName} in ServiceManager.listenToEvents`,
										);
									}
									this.logger.attach(this.docker, data.id, {
										serviceId,
										imageId,
									});
								}
							}
						} catch (e) {
							log.error('Error on docker event:', e, e.stack);
						}
					}
				}
			});

			return new Promise((resolve, reject) => {
				parser
					.on('error', (e: Error) => {
						log.error('Error on docker events stream:', e);
						reject(e);
					})
					.on('end', resolve);
				stream.pipe(parser);
			});
		};

		Bluebird.resolve(listen())
			.catch((e) => {
				log.error('Error listening to events:', e, e.stack);
			})
			.finally(() => {
				this.listening = false;
				setTimeout(() => this.listenToEvents(), 1000);
			});

		return;
	}

	public async attachToRunning() {
		const services = await this.getAll();
		for (const service of services) {
			if (service.status === 'Running') {
				const serviceId = service.serviceId;
				const imageId = service.imageId;
				if (serviceId == null || imageId == null) {
					throw new InternalInconsistencyError(
						`serviceId and imageId not defined for service: ${service.serviceName} in ServiceManager.start`,
					);
				}

				if (service.containerId == null) {
					throw new InternalInconsistencyError(
						`containerId not defined for service: ${service.serviceName} in ServiceManager.attachToRunning`,
					);
				}
				this.logger.attach(this.docker, service.containerId, {
					serviceId,
					imageId,
				});
			}
		}
	}

	public async getContainerIdMap(appId: number): Promise<Dictionary<string>> {
		return _(await this.getAllByAppId(appId))
			.keyBy('serviceName')
			.mapValues('containerId')
			.value() as Dictionary<string>;
	}

	private reportChange(containerId?: string, status?: Partial<Service>) {
		if (containerId != null) {
			if (status != null) {
				this.volatileState[containerId] = {};
				_.merge(this.volatileState[containerId], status);
			} else if (this.volatileState[containerId] != null) {
				delete this.volatileState[containerId];
			}
		}
		this.emit('change');
	}

	private reportNewStatus(
		containerId: string,
		service: Partial<Service>,
		status: string,
	) {
		this.reportChange(
			containerId,
			_.merge(
				{ status },
				_.pick(service, ['imageId', 'appId', 'releaseId', 'commit']),
			),
		);
	}

	private killContainer(
		containerId: string,
		service: Partial<Service> = {},
		{ removeContainer = true, wait = false }: KillOpts = {},
	): Bluebird<void> {
		// To maintain compatibility of the `wait` flag, this function is not
		// async, but it feels like whether or not the promise should be waited on
		// should performed by the caller
		// TODO: Remove the need for the wait flag

		return Bluebird.try(() => {
			this.logger.logSystemEvent(LogTypes.stopService, { service });
			if (service.imageId != null) {
				this.reportNewStatus(containerId, service, 'Stopping');
			}

			const containerObj = this.docker.getContainer(containerId);
			const killPromise = Bluebird.resolve(containerObj.stop())
				.then(() => {
					if (removeContainer) {
						return containerObj.remove({ v: true });
					}
				})
				.catch((e) => {
					// Get the statusCode from the original cause and make sure it's
					// definitely an int for comparison reasons
					const maybeStatusCode = PermissiveNumber.decode(e.statusCode);
					if (isLeft(maybeStatusCode)) {
						throw new Error(
							`Could not parse status code from docker error:  ${e}`,
						);
					}
					const statusCode = maybeStatusCode.right;

					// 304 means the container was already stopped, so we can just remove it
					if (statusCode === 304) {
						this.logger.logSystemEvent(LogTypes.stopServiceNoop, { service });
						// Why do we attempt to remove the container again?
						if (removeContainer) {
							return containerObj.remove({ v: true });
						}
					} else if (statusCode === 404) {
						// 404 means the container doesn't exist, precisely what we want!
						this.logger.logSystemEvent(LogTypes.stopRemoveServiceNoop, {
							service,
						});
					} else {
						throw e;
					}
				})
				.tap(() => {
					delete this.containerHasDied[containerId];
					this.logger.logSystemEvent(LogTypes.stopServiceSuccess, { service });
				})
				.catch((e) => {
					this.logger.logSystemEvent(LogTypes.stopServiceError, {
						service,
						error: e,
					});
				})
				.finally(() => {
					if (service.imageId != null) {
						this.reportChange(containerId);
					}
				});

			if (wait) {
				return killPromise;
			}
			return;
		});
	}

	private async listWithBothLabels(
		labelList: string[],
	): Promise<Dockerode.ContainerInfo[]> {
		const listWithPrefix = (prefix: string) =>
			this.docker.listContainers({
				all: true,
				filters: {
					label: _.map(labelList, (v) => `${prefix}${v}`),
				},
			});

		const [legacy, current] = await Promise.all([
			listWithPrefix('io.resin.'),
			listWithPrefix('io.balena.'),
		]);

		return _.unionBy(legacy, current, 'Id');
	}

	private async prepareForHandover(service: Service) {
		const svc = await this.get(service);
		if (svc.containerId == null) {
			throw new InternalInconsistencyError(
				`No containerId provided for service ${service.serviceName} in ServiceManager.prepareForHandover. Service: ${service}`,
			);
		}
		const container = this.docker.getContainer(svc.containerId);
		await container.update({ RestartPolicy: {} });
		return await container.rename({
			name: `old_${service.serviceName}_${service.imageId}_${service.imageId}_${service.releaseId}`,
		});
	}

	private waitToKill(service: Service, timeout: number | string) {
		const pollInterval = 100;
		timeout = checkInt(timeout, { positive: true }) || 60000;
		const deadline = Date.now() + timeout;

		const handoverCompletePaths = service.handoverCompleteFullPathsOnHost();

		const wait = (): Bluebird<void> =>
			Bluebird.any(
				handoverCompletePaths.map((file) =>
					fs.stat(file).then(() => fs.unlink(file).catch(_.noop)),
				),
			).catch(async () => {
				if (Date.now() < deadline) {
					await Bluebird.delay(pollInterval);
					return wait();
				} else {
					log.info(
						`Handover timeout has passed, assuming handover was completed for service ${service.serviceName}`,
					);
				}
			});

		log.info(
			`Waiting for handover to be completed for service: ${service.serviceName}`,
		);

		return wait().then(() => {
			log.success(`Handover complete for service ${service.serviceName}`);
		});
	}
}

export default ServiceManager;
