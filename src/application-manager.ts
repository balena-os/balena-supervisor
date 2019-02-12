import * as Bluebird from 'bluebird';
import bodyParser = require('body-parser');
import { ImageInspectInfo } from 'dockerode';
import { EventEmitter } from 'events';
import * as express from 'express';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import StrictEventEmitter from 'strict-event-emitter-types';

import Config from './config';
import Database from './db';
import DeviceState = require('./device-state');
import EventTracker from './event-tracker';
import constants = require('./lib/constants');
import Docker, { DeltaFetchOptions } from './lib/docker-utils';
import { pathExistsOnHost } from './lib/fs-utils';
import Logger from './logger';
import Proxyvisor = require('./proxyvisor');

import Images, { Image } from './compose/images';
import { Network } from './compose/network';
import NetworkManager from './compose/network-manager';
import { Service, ServiceCreateOpts } from './compose/service';
import ServiceManager from './compose/service-manager';
import Volume from './compose/volume';
import VolumeManager from './compose/volume-manager';
import { createV1Api } from './device-api/v1';
import { createV2Api } from './device-api/v2';
import LocalModeManager from './local-mode';

import {
	ActionExecutorKeys,
	ActionExecutors,
	ActionExecutorStep,
	ActionExecutorStepT,
} from './actions';
import { ComparibleComposeObject } from './compose/types/comparable';
import { ConfigMap, DeviceMetadata } from './compose/types/service';
import { InternalInconsistencyError, NotFoundError } from './lib/errors';
import * as UpdateLock from './lib/update-lock';
import { checkInt, checkString, checkTruthy } from './lib/validation';
import {
	ComposeService,
	DependentDeviceApplicationState,
	DeviceApplicationCompositionState,
	DeviceApplicationLocalState,
	DeviceApplicationStateForReport,
} from './types/state';

interface ApplicationManagerEvents {
	change: void | { update_downloaded: boolean };
}
type ApplicationManagerEventEmitter = StrictEventEmitter<
	EventEmitter,
	ApplicationManagerEvents
>;

interface ApplicationManagerConstructOpts {
	logger: Logger;
	config: Config;
	db: Database;
	eventTracker: EventTracker;
	deviceState: DeviceState;
}

interface ApplicationsObject {
	[appId: number]: {
		appId: number;
		services: Service[];
		// TODO: Type these explicitly, and use io-ts to validate it
		volumes: { [name: string]: ConfigMap };
		networks: { [name: string]: ConfigMap };
		commit?: string;
	};
}

// This is a similar data structure to the one above,
// but the services, volumes and networks have all been
// converted to their respective class instances
interface ComposeApplication {
	appId?: number;
	services: Service[];
	volumes: Volume[];
	networks: Network[];
	commit?: string;
}

interface UpdateContext {
	targetApp: ComposeApplication;
	networkPairs: NetworkChangePair[];
	volumePairs: VolumeChangePair[];
	installPairs: ServiceChangePair[];
	availableImages: Image[];
	updatePairs: ServiceChangePair[];
	downloading: number[];
}

interface ChangePair<T> {
	current: T | null;
	target: T | null;
}
type VolumeChangePair = ChangePair<Volume>;
type NetworkChangePair = ChangePair<Network>;
type ServiceChangePair = ChangePair<Service>;
type Comparison<T> = {
	current: { [name: string]: T };
	target: { [name: string]: T };
};
type VolumesComparison = Comparison<Volume>;
type NetworksComparison = Comparison<Network>;
type ServicesComparison = Comparison<Service>;

// Helper to check the various flags we need to be configured in action steps
// Example:
// ensureActionFlag('stop', () => step.current.id != null)
// => Error: Value not set in action executor stop: step.current.id != null
// NOTE: It's important to use a lambda for the output to look right
const ensureActionFlag = (step: string, fn: () => boolean) => {
	if (!fn()) {
		const fnString = fn.toString();
		throw new InternalInconsistencyError(
			`Value not set in action executor ${step}: ${fnString.slice(
				fnString.indexOf('>') + 2,
			)}`,
		);
	}
};

// Ensure a field exists on an object
const ensureField = <T extends object, U extends keyof T>(
	obj: T,
	field: U,
	defaultValue: T[U],
) => {
	if (obj[field] == null) {
		obj[field] = defaultValue;
	}
};

// Type-safe version of serviceAction, originally
// implemented in device-api/common.coffee. When rewriting that
// file remove the serviceAction function
const serviceAction = <T extends ActionExecutorKeys>(
	action: T,
	args: Omit<ActionExecutorStepT<T>, 'action'>,
): ActionExecutorStepT<T> => {
	return {
		action,
		...args,
	};
};

export class ApplicationManager extends (EventEmitter as {
	new (): ApplicationManagerEventEmitter;
}) {
	private logger: Logger;
	private config: Config;
	private db: Database;
	private eventTracker: EventTracker;
	private deviceState: DeviceState;

	private docker: Docker;
	private images: Images;
	private services: ServiceManager;
	private networks: NetworkManager;
	private volumes: VolumeManager;
	private proxyvisor: Proxyvisor;
	private localModeManager: LocalModeManager;

	private timeSpentFetching = 0;
	private fetchesInProgress = 0;
	// FIXME: change these unknowns
	private targetVolatilePerImageId: Dictionary<unknown> = {};
	private containerStarted: Dictionary<unknown> = {};

	private actionExecutors: ActionExecutors;
	private validActions: string[];

	private router: express.Router;

	public constructor(opts: ApplicationManagerConstructOpts) {
		super();
		this.logger = opts.logger;
		this.config = opts.config;
		this.db = opts.db;
		this.eventTracker = opts.eventTracker;
		this.deviceState = opts.deviceState;

		this.docker = new Docker();

		this.images = new Images({
			docker: this.docker,
			logger: this.logger,
			db: this.db,
		});

		const constructOpts = {
			config: this.config,
			logger: this.logger,
			db: this.db,
			docker: this.docker,
			images: this.images,
			applications: this,
		};

		this.services = new ServiceManager(constructOpts);
		this.networks = new NetworkManager(constructOpts);
		this.volumes = new VolumeManager(constructOpts);
		this.proxyvisor = new Proxyvisor(constructOpts);
		this.localModeManager = new LocalModeManager(
			this.config,
			this.docker,
			this.logger,
			this.db,
		);

		this.actionExecutors = {
			stop: async (step, { skipLock = false } = {}) => {
				ensureActionFlag('stop', () => step.current.appId != null);
				ensureActionFlag('stop', () => step.current.containerId != null);
				await this.lockingIfNecessary(
					step.current.appId!,
					{
						force: skipLock,
						skipLock: skipLock || _.get(step.options, 'skipLock', false),
					},
					async () => {
						const wait = _.get(step.options, 'wait', false);
						await this.services.kill(step.current, {
							removeContainer: false,
							wait,
						});
						delete this.containerStarted[step.current.containerId!];
					},
				);
			},
			kill: async (step, { skipLock = false } = {}) => {
				ensureActionFlag('kill', () => step.current.appId != null);
				ensureActionFlag('kill', () => step.current.containerId != null);
				const realSkipLock = _.get(step.options, 'skipLock', false) || skipLock;
				await this.lockingIfNecessary(
					step.current.appId!,
					{
						force: skipLock,
						skipLock: realSkipLock,
					},
					async () => {
						await this.services.kill(step.current);
						delete this.containerStarted[step.current.containerId!];
						if (_.get(step.options, 'removeImage', false)) {
							await this.images.removeByDockerId(step.current.config.image);
						}
					},
				);
			},
			remove: async step => {
				// Only called for dead containers, so no need to take locks or anything
				// TODO: We should check the above assertion
				await this.services.remove(step.current);
			},
			updateMetadata: async (
				step,
				{ force = false, skipLock = false } = {},
			) => {
				ensureActionFlag('updateMetadata', () => step.current.appId != null);
				ensureActionFlag('updateMetadata', () => step.target.imageId != null);
				ensureActionFlag('updateMetadata', () => step.target.releaseId != null);

				// TODO: There must be a better way here...
				const labelSkipLock =
					checkTruthy(
						step.current.config.labels['io.balena.legacy-container'],
					) || false;
				const optsSkipLock = _.get(step.options, 'skipLock', false) as boolean;
				skipLock = skipLock || labelSkipLock || optsSkipLock;

				const target = {
					imageId: step.target.imageId!,
					releaseId: step.target.releaseId!,
				};

				await this.lockingIfNecessary(
					step.current.appId!,
					{ force, skipLock },
					async () => {
						this.services.updateMetadata(step.current, target);
					},
				);
			},
			restart: async (step, { force = false, skipLock = false } = {}) => {
				ensureActionFlag('restart', () => step.current.appId != null);
				ensureActionFlag('restart', () => step.current.containerId != null);
				await this.lockingIfNecessary(
					step.current.appId!,
					{
						force,
						skipLock: skipLock || _.get(step.options, 'skipLock', false),
					},
					async () => {
						await this.services.kill(step.current, { wait: true });
						delete this.containerStarted[step.current.containerId!];
						const container = await this.services.start(step.target);
						this.containerStarted[container.id] = true;
					},
				);
			},
			stopAll: async (_step, { force = false, skipLock = false } = {}) => {
				await this.stopAll({ force, skipLock });
			},
			start: async step => {
				const container = await this.services.start(step.target);
				this.containerStarted[container.id] = true;
			},
			updateCommit: async step => {
				await this.config.set({ currentCommit: step.target });
			},
			handover: async (step, { force = false, skipLock = false } = {}) => {
				ensureActionFlag('handover', () => step.current.appId != null);
				await this.lockingIfNecessary(
					step.current.appId!,
					{
						force,
						skipLock: skipLock || _.get(step.options, 'skipLock', false),
					},
					async () => {
						await this.services.handover(step.current, step.target);
					},
				);
			},
			fetch: async step => {
				const startTime = process.hrtime();
				this.fetchesInProgress += 1;
				const [opts, availableImages] = await Promise.all([
					this.config.get('fetchOptions'),
					this.images.getAvailable(),
				]);

				const deltaOpts: DeltaFetchOptions = _.merge(opts, {
					deltaSource: this.bestDeltaSource(step.image, availableImages),
				});
				await this.images.triggerFetch(step.image, opts, success => {
					this.fetchesInProgress -= 1;
					const elapsed = process.hrtime(startTime);
					const elapsedMs = elapsed[0] * 1000 + elapsed[1] / 1e6;
					this.timeSpentFetching += elapsedMs;

					if (success) {
						// update_downloaded is true if *any* image has been downloaded,
						// and it's relevant mostly for th elegacy GET /v1/device endpoint
						// that assumes a single container app
						this.reportCurrentState({ update_downloaded: true });
					}
				});
			},
			removeImage: async step => {
				await this.images.remove(step.image);
			},
			saveImage: async step => {
				this.images.save(step.image);
			},
			cleanup: async () => {
				const localMode = await this.config.get('localMode');
				if (!localMode) {
					await this.images.cleanup();
				}
			},
			createNetworkOrVolume: async step => {
				await step.target.create();
			},
			removeNetworkOrVolume: async step => {
				await step.current.remove();
			},
			ensureSupervisorNetwork: async () => {
				await this.networks.ensureSupervisorNetwork();
			},
			noop: async () => {
				// We don't do anything here, but return a promise to
				// maintain compatability
			},
		};

		this.validActions = _.keys(this.actionExecutors).concat(
			this.proxyvisor.validActions,
		);
		this.router = ApplicationManager.createRouter(this);
		this.images.on('change', () => this.reportCurrentState());
		this.services.on('change', () => this.reportCurrentState());
	}

	public async init() {
		await this.images.cleanupDatabase();
		await this.localModeManager.init();
		await this.services.attachToRunning();
		await this.services.listenToEvents();
	}

	public async getStatus() {
		const localMode = await this.config.get('localMode');
		return await this.internalGetStatus(localMode);
	}

	private async internalGetStatus(
		localMode: boolean,
	): Promise<DeviceApplicationStateForReport> {
		// TODO: The types become very messy in this function, and it mainly
		// stems from the fact that the Service class reperesents both target
		// state and current state, meaning things like status, serviceId, appId,
		// containerId, etc are typed as optional. There should be two different
		// types of service, TargetService and CurrentService, both of which extend
		// the base service class. This means that we can always expect a CurrentService
		// when we need these fields to exist, and skip a lot of the checking and casting
		// below
		const [services, images, currentCommit] = await Promise.all([
			this.services.getStatus(),
			this.images.getStatus(localMode),
			this.config.get('currentCommit'),
		]);

		const apps: DeviceApplicationLocalState['apps'] = {};
		const dependent: DependentDeviceApplicationState = {};
		let releaseId: number | null = null;
		// FIXME: Typing
		const creationTimesAndReleases: Dictionary<any> = {};

		// We iterate over the current running services and add them to the current state
		// of the app they belong to.
		for (const service of services) {
			const appId = service.appId;
			if (service.status == null) {
				throw new InternalInconsistencyError(
					`service.status not defined in ApplicationManager.internalGetStatus: ${service}`,
				);
			}

			ensureField(apps, appId, {});
			ensureField(apps[appId], 'services', {});
			ensureField(creationTimesAndReleases, appId, {});

			// We only send commit if all services have the same release, and it
			// matches the target release
			if (releaseId == null) {
				releaseId = service.releaseId;
			} else if (releaseId !== service.releaseId) {
				releaseId = null;
			}

			if (apps[appId].services![service.imageId] == null) {
				apps[appId].services![service.imageId] = _.merge(
					{ download_progress: null },
					_.pick(service, ['status', 'releaseId']),
				);
				creationTimesAndReleases[appId][service.imageId] = _.pick(service, [
					'createdAt',
					'releaseId',
				]);
				apps[appId].services![service.imageId].download_progress = null;
			} else {
				// There is two container with the same imageId, so this has to be a handover
				apps[appId].services![service.imageId].releaseId = _.minBy(
					[creationTimesAndReleases[appId][service.imageId], service],
					'createdAt',
				).releaseId;
				apps[appId].services![service.imageId].status = 'Handing over';
			}
		}

		for (const image of images) {
			const appId = image.appId;
			// TODO: This is defined as a number, but it should definitely be a boolean
			if (!image.dependent) {
				ensureField(apps, appId, {});
				ensureField(apps[appId], 'services', {});
				if (apps[appId].services![image.imageId] == null) {
					apps[appId].services![image.imageId] = _.merge(
						{ download_progress: null },
						_.pick(image, ['status', 'releaseId']),
					);
				}
			} else if (image.imageId != null) {
				ensureField(dependent, appId, { images: {} });
				dependent[appId].images[image.imageId] = _.merge(
					{ download_progress: null },
					_.pick(image, 'status'),
				);
			} else {
				console.log('Ignoring legacy dependent image', image);
			}
		}

		const obj: DeviceApplicationStateForReport = { local: apps, dependent };
		obj.commit = currentCommit == null ? undefined : currentCommit;
		return obj;
	}

	public getDependentState() {
		return this.proxyvisor.getCurrentStates();
	}

	public getCurrentForComparison() {
		return Bluebird.join(
			this.services.getAll(),
			this.networks.getAll(),
			this.volumes.getAll(),
			this.config.get('currentCommit'),
			this.buildApps.bind(this),
		) as ApplicationsObject;
	}

	public async getCurrentApp(appId: number) {
		// TODO: This is fairly inefficient
		const apps = (await Bluebird.join(
			this.services.getAllByAppId(appId),
			this.networks.getAllByAppId(appId),
			this.volumes.getAllByAppId(appId),
			this.config.get('currentCommit'),
			this.buildApps.bind(this),
		)) as ApplicationsObject;

		return apps[appId];
	}

	public async getTargetApp(appId: number) {
		const apiEndpoint = this.config.get('apiEndpoint');
		const [app] = await this.db
			.models('app')
			.where({ appId, source: apiEndpoint })
			.select();
		if (app == null) {
			return;
		}
		return await this.normaliseAndExtendAppFromDB(app);
	}

	// Compares current and target services and returns a list of service pairs to be updated/removed/installed.
	// The returned list is an array of objects where the `current` and target` properties define the update pair,
	// and either can be null (in the case of an install or a removal)
	private compareServicesForUpdate(
		currentServices: Service[],
		targetServices: Service[],
	) {
		interface ActionPair {
			current: Service | null;
			target: Service | null;
			serviceId: number;
		}

		const removePairs: ActionPair[] = [];
		const installPairs: ActionPair[] = [];
		const updatePairs: ActionPair[] = [];
		const targetServiceIds = _(targetServices)
			.map('serviceId')
			.reject(_.isNull)
			.value() as number[];
		const currentServiceIds = _(currentServices)
			.map('serviceId')
			.reject(_.isNull)
			.uniq()
			.value() as number[];

		const toBeRemoved = _.difference(currentServiceIds, targetServiceIds);
		for (const serviceId of toBeRemoved) {
			const servicesToRemove = _.filter(currentServices, { serviceId });
			for (const service of servicesToRemove) {
				removePairs.push({
					current: service,
					target: null,
					serviceId,
				});
			}
		}

		const toBeInstalled = _.difference(targetServiceIds, currentServiceIds);
		for (const serviceId of toBeInstalled) {
			const serviceToInstall = _.find(targetServices, { serviceId });
			if (serviceToInstall != null) {
				installPairs.push({
					current: null,
					target: serviceToInstall,
					serviceId,
				});
			}
		}

		const toBeMaybeUpdated = _.intersection(
			targetServiceIds,
			currentServiceIds,
		);
		const currentServicesPerId: { [serviceId: number]: Service } = {};
		const targetServicesPerId: { [serviceId: number]: Service } = _.keyBy(
			targetServices,
			'serviceId',
		);
		for (const serviceId of toBeMaybeUpdated) {
			const currentServiceContainers = _.filter(currentServices, { serviceId });
			if (currentServiceContainers.length > 1) {
				currentServicesPerId[serviceId] = _.maxBy(
					currentServiceContainers,
					'createdAt',
				)!;

				// All but the latest container for this service are spurious and should be removed
				for (const service of _.without(
					currentServiceContainers,
					currentServicesPerId[serviceId],
				)) {
					removePairs.push({
						current: service,
						target: null,
						serviceId,
					});
				}
			} else {
				currentServicesPerId[serviceId] = currentServiceContainers[0];
			}
		}

		const alreadyStarted = (serviceId: number) => {
			if (currentServicesPerId[serviceId].containerId == null) {
				throw new InternalInconsistencyError(
					`Container ID missing in ApplicationManager.compareServicesForUpdate.alreadyStarted: ${
						currentServicesPerId[serviceId]
					}`,
				);
			}
			return (
				currentServicesPerId[serviceId].isEqualExceptForRunningState(
					targetServicesPerId[serviceId],
				) &&
				targetServicesPerId[serviceId].config.running &&
				this.containerStarted[currentServicesPerId[serviceId].containerId!]
			);
		};

		const needUpdate = _.filter(
			toBeMaybeUpdated,
			serviceId =>
				!currentServicesPerId[serviceId].isEqual(
					targetServicesPerId[serviceId],
				) && !alreadyStarted(serviceId),
		);

		for (const serviceId of needUpdate) {
			updatePairs.push({
				current: currentServicesPerId[serviceId],
				target: targetServicesPerId[serviceId],
				serviceId,
			});
		}

		return { removePairs, installPairs, updatePairs };
	}

	private compareNetworksOrVolumesForUpdate(
		model: VolumeManager,
		comp: VolumesComparison,
	): Array<{
		current: Volume | null;
		target: Volume | null;
	}>;
	private compareNetworksOrVolumesForUpdate(
		model: NetworkManager,
		comp: NetworksComparison,
	): Array<{
		current: Network | null;
		target: Network | null;
	}>;
	private compareNetworksOrVolumesForUpdate(
		model: VolumeManager | NetworkManager,
		{ current, target }: VolumesComparison | NetworksComparison,
	) {
		const outputPairs: Array<{
			current: Volume | Network | null;
			target: Volume | Network | null;
		}> = [];
		const currentNames = _.keys(current);
		const targetNames = _.keys(target);
		const toBeRemoved = _.difference(currentNames, targetNames);

		for (const name in toBeRemoved) {
			outputPairs.push({
				current: current![name],
				target: null,
			});
		}

		const toBeInstalled = _.difference(targetNames, currentNames);
		for (const name of toBeInstalled) {
			outputPairs.push({
				current: null,
				target: target![name],
			});
		}

		const toBeUpdated = _(targetNames)
			.intersection(currentNames)
			.reject(name =>
				(current[name] as ComparibleComposeObject).isEqualConfig(target[name]),
			)
			.value();

		for (const name of toBeUpdated) {
			outputPairs.push({
				current: current[name],
				target: target[name],
			});
		}

		return outputPairs;
	}

	private compareNetworksForUpdate(networks: NetworksComparison) {
		return this.compareNetworksOrVolumesForUpdate(this.networks, networks);
	}

	private compareVolumesForUpdate(volumes: VolumesComparison) {
		return this.compareNetworksOrVolumesForUpdate(this.volumes, volumes);
	}

	// Does a service contain a reference to a network or volume?
	private hasCurrentNetworksOrVolumes(
		service: Service,
		networkPairs: NetworkChangePair[],
		volumePairs: VolumeChangePair[],
	) {
		const hasNetwork = _.some(networkPairs, pair => {
			if (pair.current == null) {
				return false;
			}
			return (
				`${service.appId}_${pair.current != null ? pair.current.name : ''}` ===
					service.config.networkMode ||
				_(service.config.networks)
					.keys()
					.includes(pair.current.name)
			);
		});
		if (hasNetwork) {
			return true;
		}

		const hasVolume = _.some(service.config.volumes, volume => {
			const name = _.split(volume, ':')[0];
			return _.some(volumePairs, pair => {
				if (pair.current == null) {
					return false;
				}
				return `${service.appId}_${pair.current.name}` === name;
			});
		});
		return hasVolume;
	}

	// TODO: Account for volumes-from, networks-from, links, etc
	// TODO: Support networks instead of only networkMode
	private dependenciesMetForServiceStart(
		target: Service,
		networkPairs: NetworkChangePair[],
		volumePairs: VolumeChangePair[],
		pendingPairs: ServiceChangePair[],
	) {
		// for dependsOn, check no install or update pairs have that service
		const dependencyUnmet = _.some(target.dependsOn, dependency =>
			_.some(pendingPairs, pair =>
				pair.target != null ? pair.target.serviceName === dependency : false,
			),
		);

		if (dependencyUnmet) {
			return false;
		}

		if (
			_.some(networkPairs, pair =>
				pair.target != null
					? `${target.appId}_${pair.target.name}` === target.config.networkMode
					: false,
			)
		) {
			return false;
		}

		const volumeUnmet = _.some(
			target.config.volumes,
			(volumeDefinition: string) => {
				const [sourceName, destName] = volumeDefinition.split(':');
				if (destName == null) {
					return false;
				}
				return _.some(volumePairs, pair =>
					pair.target != null
						? `${target.appId}_${pair.target.name}` === sourceName
						: false,
				);
			},
		);

		return !volumeUnmet;
	}

	// Unless the update strategy requires an early kill (i.e kill-then-download, delete-then-download), we only
	// want to kill a service once the images for the services it depends on have been downloaded, so as to minimize
	// downtime (but not block the killing too much, potentially causing a deadlock)
	private dependenciesMetForServiceKill(
		target: Service,
		targetApp: ComposeApplication,
		availableImages: Image[],
	) {
		for (const dep of target.dependsOn || []) {
			const dependencyService = _.find(targetApp.services, {
				serviceName: dep,
			});
			if (dependencyService != null) {
				if (
					!_.some(
						availableImages,
						image =>
							image.dockerImageId === dependencyService.config.image ||
							image.name === dependencyService.imageName,
					)
				) {
					return false;
				}
			}
		}
		return true;
	}

	private nextStepsForNetworkOrVolume<T extends Network | Volume>(
		netOrVolPair: ChangePair<T>,
		currentApp: ComposeApplication,
		changingPairs: ServiceChangePair[],
		dependencyComparisonFn: (service: Service, potentialDep: T) => boolean,
		model: 'network' | 'volume',
	): ActionExecutorStep[] {
		const { current, target } = netOrVolPair;
		// Check none of the currentApp.services use this network or volume
		if (current != null) {
			const deps = _.filter(currentApp.services, service =>
				dependencyComparisonFn(service, current),
			);
			if (_.isEmpty(deps)) {
				return [serviceAction('removeNetworkOrVolume', { model, current })];
			} else {
				// If the current update doesn't require killing the services that use
				// this network/volume we have to kill them before removing the network/volume
				// (e.g when we're only updating the network config)
				const steps = [];
				for (const dep of deps) {
					if (
						dep.status !== 'Stopping' &&
						!_.some(changingPairs, { serviceId: dep.serviceId })
					) {
						steps.push(serviceAction('kill', { current: dep }));
					}
				}
				return steps;
			}
		} else if (target != null) {
			return [serviceAction('createNetworkOrVolume', { model, target })];
		} else {
			return [];
		}
	}

	private nextStepsForNetwork(
		opts: NetworkChangePair,
		currentApp: ComposeApplication,
		changingPairs: ServiceChangePair[],
	) {
		const dependencyComparisonFn = (service: Service, current: Network) => {
			// TODO: Handle multiple networks here, not jus network mode
			return current != null
				? service.config.networkMode === `${service.appId}_${current.name}`
				: false;
		};

		return this.nextStepsForNetworkOrVolume(
			opts,
			currentApp,
			changingPairs,
			dependencyComparisonFn,
			'network',
		);
	}

	private nextStepsForVolume(
		opts: VolumeChangePair,
		currentApp: ComposeApplication,
		changingPairs: ServiceChangePair[],
	) {
		const dependencyComparisonFn = (service: Service, current: Volume) =>
			_.some(service.config.volumes, volume => {
				const [sourceName, destName] = volume.split(':');
				return current != null
					? destName != null &&
							sourceName === `${service.appId}_${current.name}`
					: false;
			});

		return this.nextStepsForNetworkOrVolume(
			opts,
			currentApp,
			changingPairs,
			dependencyComparisonFn,
			'volume',
		);
	}

	private updateContainerStep(current: Service, target: Service) {
		if (target.serviceId == null) {
			throw new InternalInconsistencyError(
				`Service has no service ID in ApplicationManager.updateContainerStep: ${target}`,
			);
		}
		if (
			current.releaseId !== target.releaseId ||
			current.imageId !== target.imageId
		) {
			return serviceAction('updateMetadata', { current, target });
		} else if (target.config.running) {
			return serviceAction('start', { target });
		} else {
			return serviceAction('stop', { current });
		}
	}

	private fetchOrStartStep(
		target: Service,
		needsDownload: boolean,
		depsMetForStart: () => boolean,
	): ActionExecutorStep | null {
		if (needsDownload) {
			return ApplicationManager.fetchAction(target);
		} else if (depsMetForStart()) {
			return serviceAction('start', { target });
		} else {
			return null;
		}
	}

	private static strategySteps = {
		'download-then-kill': (
			current: Service,
			target: Service,
			needsDownload: boolean,
			// TODO: Remove this from the call
			_depsMetForStart: () => boolean,
			depsMetForKill: () => boolean,
		): ActionExecutorStep | null => {
			if (needsDownload) {
				return ApplicationManager.fetchAction(target);
			} else if (depsMetForKill()) {
				// We only kill when dependencies are already met, so that we minimize downtime
				return serviceAction('kill', { current });
			}
			return null;
		},
		'kill-then-download': (current: Service) =>
			serviceAction('kill', { current }),
		'delete-then-download': (
			current: Service,
			_target: Service,
			needsDownload: boolean,
		) =>
			serviceAction('kill', {
				current,
				options: { removeImage: needsDownload },
			}),
		'hand-over': (
			current: Service,
			target: Service,
			needsDownload: boolean,
			depsMetForStart: () => boolean,
			depsMetForKill: () => boolean,
			needsSpecialKill: boolean,
		) => {
			if (needsDownload) {
				return ApplicationManager.fetchAction(target);
			} else if (needsSpecialKill && depsMetForKill()) {
				return serviceAction('kill', { current });
			} else if (depsMetForStart()) {
				return serviceAction('handover', {
					current,
					target,
					// Currently not used in the handler
					// FIXME: Work out if providing it here is wrong or not using
					// it in the action executor is wrong
					// options: { timeout },
				});
			}
		},
	};

	private nextStepsForService(
		{ current, target }: ServiceChangePair,
		updateContext: UpdateContext,
		localMode: boolean,
		// FIXME: Check if we can return `noop` here rather than null, to make
		// it a little cleaner
	): ActionExecutorStep | null {
		const {
			targetApp,
			networkPairs,
			volumePairs,
			installPairs,
			updatePairs,
			availableImages,
			downloading,
		} = updateContext;

		if (current != null) {
			if (current.status === 'Stopping') {
				// There is already a kill step in progress for this service, so we wait
				return serviceAction('noop', {});
			}
			if (current.status === 'Dead') {
				// Dead containers have to be removed
				return serviceAction('remove', { current });
			}
		}

		// Don't attemp to fetch any images in local mode, they should already be there
		const needsDownload =
			!localMode &&
			_.some(availableImages, (image: Image) =>
				target != null
					? image.dockerImageId === target.config.image ||
					  image.name === target.imageName
					: false,
			);

		// Every step past this needs a target set
		if (target == null) {
			throw new InternalInconsistencyError(
				`Target not set in ApplicationManager.nextStepsForService`,
			);
		}

		// This service needs an image download but it's currently downlolading, so we wait
		if (needsDownload && _.includes(downloading, target.imageId)) {
			return serviceAction('noop', {});
		}

		const depsMetForStart = () =>
			this.dependenciesMetForServiceStart(
				target,
				networkPairs,
				volumePairs,
				installPairs.concat(updatePairs),
			);
		const depsMetForKill = () =>
			!needsDownload &&
			this.dependenciesMetForServiceKill(target, targetApp, availableImages);

		if (current && current.isEqualConfig(target)) {
			// We're only stopping/starting it
			return this.updateContainerStep(current, target);
		} else if (current == null) {
			// Either this is a new service, or the current one has already been killed
			return this.fetchOrStartStep(target, needsDownload, depsMetForStart);
		} else {
			// If the service is using a network or volume that is being updated, we need to kill it
			// even it's strategy is handover
			const needsSpecialKill = this.hasCurrentNetworksOrVolumes(
				current,
				networkPairs,
				volumePairs,
			);
			let strategy = checkString(
				target.config.labels['io.balena.update.strategy'],
			);
			const validStrategies = _.keys(ApplicationManager.strategySteps);

			if (!_.includes(validStrategies, strategy)) {
				console.log(
					`Warning: Unknown update strategy: ${strategy}, defaulting to 'download-then-kill'`,
				);
				strategy = 'download-then-kill';
			}

			const strategyKey = strategy as keyof typeof ApplicationManager.strategySteps;

			// TODO: Find a nicer way of typing this
			return (ApplicationManager.strategySteps[strategyKey] as (
				...args: Array<unknown>
			) => ActionExecutorStep)(
				current,
				target,
				needsDownload,
				depsMetForStart,
				depsMetForKill,
				needsSpecialKill,
			);
		}
	}

	private nextStepsForAppUpdate(
		currentApp: ComposeApplication | null,
		targetApp: ComposeApplication,
		localMode: boolean,
		availableImages: Image[] = [],
		downloading: number[] = [],
	) {
		if (currentApp == null) {
			currentApp = targetApp;
		}

		if (
			currentApp.services != null &&
			currentApp.services.length === 1 &&
			targetApp.services != null &&
			targetApp.services.length === 1 &&
			targetApp.services[0].serviceName ===
				currentApp.services[0].serviceName &&
			checkTruthy(
				currentApp.services[0].config.labels['io.balena.legacy-container'],
			)
		) {
			// This is a legacy preloaded app or container, so we didn't have things like serviceId.
			// We hack a few things to avoid an unnecessary restart of the preloaded app, (but ensuring
			// it gets updated if it actually changed)
			targetApp.services[0].config.labels['io.balena.legacy-container'] =
				currentApp.services[0].config.labels['io.balena.legacy-container'];
			targetApp.services[0].config.labels['io.balena.service-id'] =
				currentApp.services[0].config.labels['io.balena.service-id'];
			targetApp.services[0].serviceId = currentApp.services[0].serviceId;
		}

		const appId = targetApp.appId != null ? targetApp.appId : currentApp.appId;
		if (appId == null) {
			throw new InternalInconsistencyError(
				`No application id in nextStepsForAppUpdate`,
			);
		}

		const networkPairs = this.compareNetworksForUpdate({
			current: _.keyBy(currentApp.networks, 'name'),
			target: _.keyBy(targetApp.networks, 'name'),
		});
		const volumePairs = this.compareVolumesForUpdate({
			current: _.keyBy(currentApp.volumes, 'name'),
			target: _.keyBy(targetApp.volumes, 'name'),
		});

		const {
			removePairs,
			installPairs,
			updatePairs,
		} = this.compareServicesForUpdate(
			currentApp.services || [],
			targetApp.services || [],
		);

		let steps = [];
		// All removePairs get a 'kill' action
		for (const pair of removePairs) {
			if (pair.current && pair.current.status !== 'Stopping') {
				steps.push(serviceAction('kill', { current: pair.current }));
			} else {
				steps.push(serviceAction('noop', {}));
			}
		}

		// next step for install pairs in download - start order, but start requires dependencies,
		//  networks and volumes met
		// next step for update pairs in order by update strategy. Start requires dependencies, networks
		//  and volumes met.
		for (const pair of installPairs.concat(updatePairs)) {
			const step = this.nextStepsForService(
				pair,
				{
					targetApp,
					networkPairs,
					volumePairs,
					installPairs,
					updatePairs,
					availableImages,
					downloading,
				},
				localMode,
			);
			if (step != null) {
				steps.push(step);
			}
		}

		for (const pair of networkPairs) {
			const pairSteps = this.nextStepsForNetwork(
				pair,
				currentApp,
				removePairs.concat(updatePairs),
			);
			steps = steps.concat(pairSteps);
		}

		for (const pair of volumePairs) {
			const pairSteps = this.nextStepsForVolume(
				pair,
				currentApp,
				removePairs.concat(updatePairs),
			);
			steps = steps.concat(pairSteps);
		}

		if (_.isEmpty(steps) && currentApp.commit !== targetApp.commit) {
			if (targetApp.commit == null) {
				throw new InternalInconsistencyError(
					`Attempt to update commit to a null commit! Target app: ${targetApp}`,
				);
			}
			steps.push(serviceAction('updateCommit', { target: targetApp.commit }));
		}

		return steps;
	}

	// TODO: When the database typings are in place, set the return type properly here
	// FIXME: Make static
	// TODO: Because this class is so big, we should extract methods like this to another
	//  helper class
	private async normaliseAppForDB(
		app: DeviceApplicationCompositionState & { appId: number; source: string },
	): Promise<Dictionary<unknown>> {
		const services = _.map(app.services, (s, svcId) => {
			const service = _.cloneDeep(s);
			service.appId = app.appId;
			service.releaseId = app.releaseId;
			// TODO I'm not sure we still need this checkInt, and we
			// definitely won't when we validate the incoming target state
			// with io-ts
			service.serviceId = checkInt(svcId);
			service.commit = app.commit;
			return service;
		});

		for (const service of services) {
			service.image = await this.images.normalise(service.image);
		}

		return {
			appId: app.appId,
			commit: app.commit,
			name: app.name,
			source: app.source,
			releaseId: app.releaseId,
			services: JSON.stringify(services),
			networks: JSON.stringify(app.networks || {}),
			volumes: JSON.stringify(app.volumes || {}),
		};
	}

	private buildApps(
		services: Service[],
		networks: Network[],
		volumes: Volume[],
		currentCommit: string | undefined,
	): ApplicationsObject {
		const apps: ApplicationsObject = {};

		// Ensure each app has the fields it requires
		_([networks, volumes, services] as Array<Array<{ appId: number }>>)
			.flatten()
			.map('appId')
			.uniq()
			.each(appId =>
				ensureField(apps, appId, {
					appId,
					services: [],
					volumes: {},
					networks: {},
				}),
			);

		// We iterate over the current running services and add them to the current state
		// of the app they belong to
		for (const service of services) {
			if (service.appId == null) {
				throw new InternalInconsistencyError(
					`service.appId not set in ApplicationManager.buildApps: ${service}`,
				);
			}
			apps[service.appId].services.push(service);
		}

		for (const network of networks) {
			apps[network.appId].networks[network.name] = network.config;
		}

		for (const volume of volumes) {
			apps[volume.appId].volumes[volume.name] = volume.config;
		}

		// Multi-app warning!
		// This is just wrong on every level
		_.each(apps, app => {
			app.commit = currentCommit;
		});

		return apps;
	}

	private reportCurrentState(data: ApplicationManagerEvents['change']) {
		this.emit('change', data);
	}

	private async lockingIfNecessary(
		appId: number,
		{
			force = false,
			skipLock = false,
		}: { force?: boolean; skipLock?: boolean } = {},
		fn: () => PromiseLike<void>,
	) {
		if (skipLock) {
			return Bluebird.try(fn);
		}

		const lockOverride = await this.config.get('lockOverride');
		UpdateLock.lock(appId, { force: force || lockOverride }, fn);
	}

	private static imageForService(service: Service): Image {
		const allSet = _(service)
			.pick([
				'name',
				'appId',
				'serviceId',
				'serviceName',
				'imageId',
				'releaseId',
				'dependent',
			])
			.every(v => v != null);
		if (!allSet) {
			throw new InternalInconsistencyError(
				`Attempt to create image from service with incomplete fields: ${service}`,
			);
		}

		return {
			name: service.imageName,
			appId: service.appId,
			serviceId: service.serviceId,
			serviceName: service.serviceName,
			imageId: service.imageId,
			releaseId: service.releaseId,
			dependent: 0,
			downloadProgress: null,
		};
	}

	// FIXME: Properly type the opts value
	private async createTargetService(
		service: ComposeService,
		createOpts: ServiceCreateOpts,
		opts: Omit<DeviceMetadata, 'imageInfo'>,
	): Promise<Service> {
		let imageInfo: ImageInspectInfo | null;
		try {
			imageInfo = await this.images.inspectByName(service.image);
		} catch (e) {
			if (!NotFoundError(e)) {
				throw e;
			}
			imageInfo = null;
		}

		const deviceOpts: DeviceMetadata = _.assign({ imageInfo }, opts);
		if (imageInfo != null && imageInfo.Id != null) {
			service.image = imageInfo.Id;
		}
		return Service.fromComposeObject(createOpts, service, deviceOpts);
	}

	// TODO: When the database schema is fully typed, change the below
	private async normaliseAndExtendAppFromDB(app: Dictionary<unknown>) {
		const opts = await this.config.get('extendedEnvOptions');
		const supervisorApiHost = await this.docker
			.getNetworkGateway(constants.supervisorNetworkInterface)
			.catch(() => '127.0.0.1');
		const hostPathExists = await Bluebird.props({
			firmware: pathExistsOnHost('/lib/firmware'),
			modules: pathExistsOnHost('/lib/modules'),
		});
		const hostnameOnHost = (await fs.readFile(
			path.join(constants.rootMountPoint, '/etc/hostname'),
			'utf8',
		)).trim();

		const configOpts = _.assign(
			{
				appName: app.name as string,
				supervisorApiHost,
				hostPathExists,
				hostnameOnHost,
			},
			opts,
		);

		const volumes = _.mapValues(
			JSON.parse(app.volumes as string),
			volumeConfig => {
				if (volumeConfig == null) {
					volumeConfig = {};
				}
				if (volumeConfig.labels == null) {
					volumeConfig.label = {};
				}
				return volumeConfig;
			},
		);

		let services: Service[] = [];
		for (const svc of JSON.parse(app.services as string)) {
			services.push(
				await this.createTargetService(
					svc,
					{
						appId: svc.appId,
						imageId: svc.imageId,
						serviceName: svc.serviceName,
						releaseId: svc.releaseId,
						serviceId: svc.serviceId,
						imageName: svc.image,
					},
					configOpts,
				),
			);
		}

		HERE;
	}

	private static fetchAction(service: Service): ActionExecutorStepT<'fetch'> {
		return serviceAction('fetch', {
			image: ApplicationManager.imageForService(service),
		});
	}

	private static createRouter(apps: ApplicationManager): express.Router {
		const router = express.Router();
		router.use(bodyParser.urlencoded({ extended: true }));
		router.use(bodyParser.json());

		createV1Api(router, apps);
		createV2Api(router, apps);

		router.use(apps.proxyvisor.router);

		return router;
	}
}

export default ApplicationManager;
