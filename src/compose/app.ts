import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';

import Network from './network';
import Volume from './volume';
import Service from './service';

import * as imageManager from './images';
import type { Image } from './images';
import {
	CompositionStep,
	generateStep,
	CompositionStepAction,
} from './composition-steps';
import * as targetStateCache from '../device-state/target-state-cache';
import * as dockerUtils from '../lib/docker-utils';
import constants = require('../lib/constants');

import { getStepsFromStrategy } from './update-strategies';

import { InternalInconsistencyError, NotFoundError } from '../lib/errors';
import * as config from '../config';
import { checkTruthy, checkString } from '../lib/validation';
import { ServiceComposeConfig, DeviceMetadata } from './types/service';
import { ImageInspectInfo } from 'dockerode';
import { getSupervisorMetadata } from '../lib/supervisor-metadata';

export interface AppConstructOpts {
	appId: number;
	appUuid?: string;
	appName?: string;
	commit?: string;
	source?: string;
	isHost?: boolean;

	services: Service[];
	volumes: Dictionary<Volume>;
	networks: Dictionary<Network>;
}

export interface UpdateState {
	localMode: boolean;
	availableImages: Image[];
	containerIds: Dictionary<string>;
	downloading: string[];
}

interface ChangingPair<T> {
	current?: T;
	target?: T;
}

export class App {
	public appId: number;
	public appUuid?: string;
	// When setting up an application from current state, these values are not available
	public appName?: string;
	public commit?: string;
	public source?: string;
	public isHost?: boolean;

	// Services are stored as an array, as at any one time we could have more than one
	// service for a single service ID running (for example handover)
	public services: Service[];
	public networks: Dictionary<Network>;
	public volumes: Dictionary<Volume>;

	public constructor(opts: AppConstructOpts, public isTargetState: boolean) {
		this.appId = opts.appId;
		this.appUuid = opts.appUuid;
		this.appName = opts.appName;
		this.commit = opts.commit;
		this.source = opts.source;
		this.services = opts.services;
		this.volumes = opts.volumes;
		this.networks = opts.networks;
		this.isHost = !!opts.isHost;

		if (this.networks.default == null && isTargetState) {
			// We always want a default network
			this.networks.default = Network.fromComposeObject(
				'default',
				opts.appId,
				opts.appUuid!, // app uuid always exists on the target state
				{},
			);
		}
	}

	public nextStepsForAppUpdate(
		state: UpdateState,
		target: App,
	): CompositionStep[] {
		// Check to see if we need to polyfill in some "new" data for legacy services
		this.migrateLegacy(target);

		// Check for changes in the volumes. We don't remove any volumes until we remove an
		// entire app
		const volumeChanges = this.compareComponents(
			this.volumes,
			target.volumes,
			false,
		);
		const networkChanges = this.compareComponents(
			this.networks,
			target.networks,
			true,
		);

		let steps: CompositionStep[] = [];

		// Any services which have died get a remove step
		for (const service of this.services) {
			if (service.status === 'Dead') {
				steps.push(generateStep('remove', { current: service }));
			}
		}

		const { removePairs, installPairs, updatePairs } = this.compareServices(
			this.services,
			target.services,
			state.containerIds,
		);

		for (const { current: svc } of removePairs) {
			// All removes get a kill action if they're not already stopping
			if (svc!.status !== 'Stopping') {
				steps.push(generateStep('kill', { current: svc! }));
			} else {
				steps.push(generateStep('noop', {}));
			}
		}

		// For every service which needs to be updated, update via update strategy.
		const servicePairs = updatePairs.concat(installPairs);
		steps = steps.concat(
			servicePairs
				.map((pair) =>
					this.generateStepsForService(pair, {
						...state,
						servicePairs: installPairs.concat(updatePairs),
						targetApp: target,
						networkPairs: networkChanges,
						volumePairs: volumeChanges,
					}),
				)
				.filter((step) => step != null) as CompositionStep[],
		);

		// Generate volume steps
		steps = steps.concat(
			this.generateStepsForComponent(volumeChanges, servicePairs, (v, svc) =>
				svc.hasVolume(v.name),
			),
		);
		// Generate network steps
		steps = steps.concat(
			this.generateStepsForComponent(networkChanges, servicePairs, (n, svc) =>
				svc.hasNetwork(n.name),
			),
		);

		if (
			steps.length === 0 &&
			target.commit != null &&
			this.commit !== target.commit
		) {
			steps.push(
				generateStep('updateCommit', {
					target: target.commit,
					appId: this.appId,
				}),
			);
		}

		return steps;
	}

	public async stepsToRemoveApp(
		state: Omit<UpdateState, 'availableImages'>,
	): Promise<CompositionStep[]> {
		if (Object.keys(this.services).length > 0) {
			return Object.values(this.services).map((service) =>
				generateStep('kill', { current: service }),
			);
		}
		if (Object.keys(this.networks).length > 0) {
			return Object.values(this.networks).map((network) =>
				generateStep('removeNetwork', { current: network }),
			);
		}
		// Don't remove volumes in local mode
		if (!state.localMode) {
			if (Object.keys(this.volumes).length > 0) {
				return Object.values(this.volumes).map((volume) =>
					generateStep('removeVolume', { current: volume }),
				);
			}
		}

		return [];
	}

	private migrateLegacy(target: App) {
		const currentServices = Object.values(this.services);
		const targetServices = Object.values(target.services);
		if (
			currentServices.length === 1 &&
			targetServices.length === 1 &&
			targetServices[0].serviceName === currentServices[0].serviceName &&
			checkTruthy(
				currentServices[0].config.labels['io.balena.legacy-container'],
			)
		) {
			// This is a legacy preloaded app or container, so we didn't have things like serviceId.
			// We hack a few things to avoid an unnecessary restart of the preloaded app
			// (but ensuring it gets updated if it actually changed)
			targetServices[0].config.labels['io.balena.legacy-container'] =
				currentServices[0].config.labels['io.balena.legacy-container'];
			targetServices[0].config.labels['io.balena.service-id'] =
				currentServices[0].config.labels['io.balena.service-id'];
			targetServices[0].serviceId = currentServices[0].serviceId;
		}
	}

	private compareComponents<T extends { isEqualConfig(target: T): boolean }>(
		current: Dictionary<T>,
		target: Dictionary<T>,
		// Should this function issue remove steps? (we don't want to for volumes)
		generateRemoves: boolean,
	): Array<ChangingPair<T>> {
		const currentNames = _.keys(current);
		const targetNames = _.keys(target);

		const outputs: Array<{ current?: T; target?: T }> = [];

		if (generateRemoves) {
			for (const name of _.difference(currentNames, targetNames)) {
				outputs.push({ current: current[name] });
			}
		}
		for (const name of _.difference(targetNames, currentNames)) {
			outputs.push({ target: target[name] });
		}

		const toBeUpdated = _.filter(
			_.intersection(targetNames, currentNames),
			(name) => !current[name].isEqualConfig(target[name]),
		);
		for (const name of toBeUpdated) {
			outputs.push({ current: current[name], target: target[name] });
		}

		return outputs;
	}

	private compareServices(
		current: Service[],
		target: Service[],
		containerIds: Dictionary<string>,
	): {
		installPairs: Array<ChangingPair<Service>>;
		removePairs: Array<ChangingPair<Service>>;
		updatePairs: Array<ChangingPair<Service>>;
	} {
		const currentByServiceName = _.keyBy(current, 'serviceName');
		const targetByServiceName = _.keyBy(target, 'serviceName');

		const currentServiceNames = Object.keys(currentByServiceName);
		const targetServiceNames = Object.keys(targetByServiceName);

		const toBeRemoved = _(currentServiceNames)
			.difference(targetServiceNames)
			.map((id) => ({ current: currentByServiceName[id] }))
			.value();

		const toBeInstalled = _(targetServiceNames)
			.difference(currentServiceNames)
			.map((id) => ({ target: targetByServiceName[id] }))
			.value();

		const maybeUpdate = _.intersection(targetServiceNames, currentServiceNames);

		// Build up a list of services for a given service name, always using the latest created
		// service. Any older services will have kill steps emitted
		for (const serviceName of maybeUpdate) {
			const currentServiceContainers = _.filter(current, { serviceName });
			if (currentServiceContainers.length > 1) {
				currentByServiceName[serviceName] = _.maxBy(
					currentServiceContainers,
					'createdAt',
				)!;

				// All but the latest container for the service are spurious and should
				// be removed
				const otherContainers = _.without(
					currentServiceContainers,
					currentByServiceName[serviceName],
				);
				for (const service of otherContainers) {
					toBeRemoved.push({ current: service });
				}
			} else {
				currentByServiceName[serviceName] = currentServiceContainers[0];
			}
		}

		/**
		 * Checks that the config for the current and target services matches, ignoring their run state.
		 * @param serviceCurrent
		 * @param serviceTarget
		 */
		const isEqualExceptForRunningState = (
			serviceCurrent: Service,
			serviceTarget: Service,
		) =>
			serviceCurrent.isEqualExceptForRunningState(serviceTarget, containerIds);

		/**
		 * Checks if a service is running, if we tracked it as being started, if the config matches the desired config, and if we actually want it to ever be started.
		 * @param serviceCurrent
		 * @param serviceTarget
		 */
		const shouldBeStarted = (
			serviceCurrent: Service,
			serviceTarget: Service,
		) => {
			// If the target run state is stopped, or we are actually running, then we don't care about anything else
			if (
				serviceTarget.config.running === false ||
				serviceCurrent.config.running === true
			) {
				return false;
			}

			// Only start a Service if we have never started it before and the service matches target!
			// This is so the engine can handle the restart policy configured for the container.
			return (
				(serviceCurrent.status === 'Installing' ||
					serviceCurrent.status === 'Installed') &&
				isEqualExceptForRunningState(serviceCurrent, serviceTarget)
			);
		};

		/**
		 * Checks if a service should be stopped and if we have tracked it as being stopped.
		 *
		 * @param serviceCurrent
		 * @param serviceTarget
		 */
		const shouldBeStopped = (
			serviceCurrent: Service,
			serviceTarget: Service,
		) => {
			// check that we want to stop it, and that it isn't stopped
			return (
				serviceTarget.config.running === false &&
				serviceCurrent.status !== 'Stopped'
			);
		};

		/**
		 * Filter all the services which should be updated due to run state change, or config mismatch.
		 */
		const toBeUpdated = maybeUpdate
			.map((serviceName) => ({
				current: currentByServiceName[serviceName],
				target: targetByServiceName[serviceName],
			}))
			.filter(
				({ current: c, target: t }) =>
					!isEqualExceptForRunningState(c, t) ||
					shouldBeStarted(c, t) ||
					shouldBeStopped(c, t),
			);

		return {
			installPairs: toBeInstalled,
			removePairs: toBeRemoved,
			updatePairs: toBeUpdated,
		};
	}

	// We also accept a changingServices list, so we can avoid outputting multiple kill
	// steps for a service
	// FIXME: It would make the function simpler if we could just output the steps we want,
	// and the nextStepsForAppUpdate function makes sure that we're not repeating steps.
	// I'll leave it like this for now as this is how it was in application-manager.js, but
	// it should be changed.
	private generateStepsForComponent<T extends Volume | Network>(
		components: Array<ChangingPair<T>>,
		changingServices: Array<ChangingPair<Service>>,
		dependencyFn: (component: T, service: Service) => boolean,
	): CompositionStep[] {
		if (components.length === 0) {
			return [];
		}

		let steps: CompositionStep[] = [];

		const actions: {
			create: CompositionStepAction;
			remove: CompositionStepAction;
		} =
			(components[0].current ?? components[0].target) instanceof Volume
				? { create: 'createVolume', remove: 'removeVolume' }
				: { create: 'createNetwork', remove: 'removeNetwork' };

		for (const { current, target } of components) {
			// If a current exists, we're either removing it or updating the configuration. In
			// both cases, we must remove the component first, so we output those steps first.
			// If we do remove the component, we first need to remove any services which depend
			// on the component
			if (current != null) {
				// Find any services which are currently running which need to be killed when we
				// recreate this component
				const dependencies = _.filter(this.services, (s) =>
					dependencyFn(current, s),
				);
				if (dependencies.length > 0) {
					// We emit kill steps for these services, and wait to destroy the component in
					// the next state application loop
					// FIXME: We should add to the changingServices array, as we could emit several
					// kill steps for a service
					steps = steps.concat(
						dependencies.reduce(
							(acc, svc) =>
								acc.concat(this.generateKillStep(svc, changingServices)),
							[] as CompositionStep[],
						),
					);
				} else {
					steps = steps.concat([generateStep(actions.remove, { current })]);
				}
			} else if (target != null) {
				steps = steps.concat([generateStep(actions.create, { target })]);
			}
		}

		return steps;
	}

	private generateStepsForService(
		{ current, target }: ChangingPair<Service>,
		context: {
			localMode: boolean;
			availableImages: Image[];
			downloading: string[];
			targetApp: App;
			containerIds: Dictionary<string>;
			networkPairs: Array<ChangingPair<Network>>;
			volumePairs: Array<ChangingPair<Volume>>;
			servicePairs: Array<ChangingPair<Service>>;
		},
	): Nullable<CompositionStep> {
		if (current?.status === 'Stopping') {
			// Theres a kill step happening already, emit a noop to ensure we stay alive while
			// this happens
			return generateStep('noop', {});
		}
		if (current?.status === 'Dead') {
			// A remove step will already have been generated, so we let the state
			// application loop revisit this service, once the state has settled
			return;
		}

		let needsDownload = false;
		// don't attempt to fetch images whilst in local mode, as they should be there already
		if (!context.localMode) {
			needsDownload = !_.some(
				context.availableImages,
				(image) =>
					image.dockerImageId === target?.config.image ||
					imageManager.isSameImage(image, { name: target?.imageName! }),
			);
		}

		if (needsDownload && context.downloading.includes(target?.imageName!)) {
			// The image needs to be downloaded, and it's currently downloading. We simply keep
			// the application loop alive
			return generateStep('noop', {});
		}

		if (target && current?.isEqualConfig(target, context.containerIds)) {
			// we're only starting/stopping a service
			return this.generateContainerStep(current, target);
		} else if (current == null) {
			// Either this is a new service, or the current one has already been killed
			return this.generateFetchOrStartStep(
				target!,
				context.targetApp,
				needsDownload,
				context.availableImages,
				context.localMode,
				context.networkPairs,
				context.volumePairs,
				context.servicePairs,
			);
		} else {
			if (!target) {
				throw new InternalInconsistencyError(
					'An empty changing pair passed to generateStepsForService',
				);
			}
			const needsSpecialKill = this.serviceHasNetworkOrVolume(
				current,
				context.networkPairs,
				context.volumePairs,
			);

			let strategy =
				checkString(target.config.labels['io.balena.update.strategy']) || '';
			const validStrategies = [
				'download-then-kill',
				'kill-then-download',
				'delete-then-download',
				'hand-over',
			];

			if (!validStrategies.includes(strategy)) {
				strategy = 'download-then-kill';
			}

			const dependenciesMetForStart = this.dependenciesMetForServiceStart(
				target,
				context.targetApp,
				context.availableImages,
				context.localMode,
				context.networkPairs,
				context.volumePairs,
				context.servicePairs,
			);
			const dependenciesMetForKill = this.dependenciesMetForServiceKill(
				context.targetApp,
				context.availableImages,
				context.localMode,
			);

			return getStepsFromStrategy(strategy, {
				current,
				target,
				needsDownload,
				dependenciesMetForStart,
				dependenciesMetForKill,
				needsSpecialKill,
			});
		}
	}

	// We return an array from this function so the caller can just concatenate the arrays
	// without worrying if the step is skipped or not
	private generateKillStep(
		service: Service,
		changingServices: Array<ChangingPair<Service>>,
	): CompositionStep[] {
		if (
			service.status !== 'Stopping' &&
			!_.some(
				changingServices,
				({ current }) => current?.serviceName !== service.serviceName,
			)
		) {
			return [generateStep('kill', { current: service })];
		} else {
			return [];
		}
	}

	private serviceHasNetworkOrVolume(
		svc: Service,
		networkPairs: Array<ChangingPair<Network>>,
		volumePairs: Array<ChangingPair<Volume>>,
	): boolean {
		return (
			volumePairs.some(
				({ current }) => current && svc.hasVolume(current.name),
			) ||
			networkPairs.some(
				({ current }) => current && svc.hasNetwork(current.name),
			)
		);
	}

	private generateContainerStep(current: Service, target: Service) {
		// if the services release doesn't match, then rename the container...
		if (current.commit !== target.commit) {
			return generateStep('updateMetadata', { current, target });
		} else if (target.config.running !== current.config.running) {
			if (target.config.running) {
				return generateStep('start', { target });
			} else {
				return generateStep('stop', { current });
			}
		}
	}

	private generateFetchOrStartStep(
		target: Service,
		targetApp: App,
		needsDownload: boolean,
		availableImages: Image[],
		localMode: boolean,
		networkPairs: Array<ChangingPair<Network>>,
		volumePairs: Array<ChangingPair<Volume>>,
		servicePairs: Array<ChangingPair<Service>>,
	): CompositionStep | undefined {
		if (needsDownload) {
			// We know the service name exists as it always does for targets
			return generateStep('fetch', {
				image: imageManager.imageFromService(target),
				serviceName: target.serviceName!,
			});
		} else if (
			this.dependenciesMetForServiceStart(
				target,
				targetApp,
				availableImages,
				localMode,
				networkPairs,
				volumePairs,
				servicePairs,
			)
		) {
			return generateStep('start', { target });
		}
	}

	// TODO: account for volumes-from, networks-from, links, etc
	// TODO: support networks instead of only network mode
	private dependenciesMetForServiceStart(
		target: Service,
		targetApp: App,
		availableImages: Image[],
		localMode: boolean,
		networkPairs: Array<ChangingPair<Network>>,
		volumePairs: Array<ChangingPair<Volume>>,
		servicePairs: Array<ChangingPair<Service>>,
	): boolean {
		// Firstly we check if a dependency is not already running (this is
		// different to a dependency which is in the servicePairs below, as these
		// are services which are changing). We could have a dependency which is
		// starting up, but is not yet running.
		const depInstallingButNotRunning = _.some(targetApp.services, (svc) => {
			if (target.dependsOn?.includes(svc.serviceName!)) {
				if (!svc.config.running) {
					return true;
				}
			}
		});

		if (depInstallingButNotRunning) {
			return false;
		}

		const depedencyUnmet = _.some(target.dependsOn, (dep) =>
			_.some(servicePairs, (pair) => pair.target?.serviceName === dep),
		);

		if (depedencyUnmet) {
			return false;
		}

		// Wait for networks to be created before starting the service
		if (
			networkPairs.some(
				(pair) => pair.target && target.hasNetworkMode(pair.target.name),
			)
		) {
			return false;
		}

		// Wait for volumes to be created before starting the service
		if (
			volumePairs.some(
				(pair) => pair.target && target.hasVolume(pair.target.name),
			)
		) {
			return false;
		}

		// do not start until all images have been downloaded
		return this.targetImagesReady(targetApp, availableImages, localMode);
	}

	// Unless the update strategy requires an early kill (i.e kill-then-download,
	// delete-then-download), we only want to kill a service once the images for the
	// services it depends on have been downloaded, so as to minimize downtime (but not
	// block the killing too much, potentially causing a deadlock)
	private dependenciesMetForServiceKill(
		targetApp: App,
		availableImages: Image[],
		localMode: boolean,
	) {
		// Don't kill any services before all images have been downloaded
		return this.targetImagesReady(targetApp, availableImages, localMode);
	}

	private targetImagesReady(
		targetApp: App,
		availableImages: Image[],
		localMode: boolean,
	) {
		// because we only check for an image being available, in local mode this will always
		// be the case, so return true regardless.
		// If we ever unify image management betwen local and cloud mode, this will have to change
		if (localMode) {
			return true;
		}

		return targetApp.services.every((service) =>
			availableImages.some(
				(image) =>
					image.dockerImageId === service.config.image ||
					imageManager.isSameImage(image, { name: service.imageName! }),
			),
		);
	}

	public static async fromTargetState(
		app: targetStateCache.DatabaseApp,
	): Promise<App> {
		const volumes = _.mapValues(JSON.parse(app.volumes) ?? {}, (conf, name) => {
			if (conf == null) {
				conf = {};
			}
			if (conf.labels == null) {
				conf.labels = {};
			}
			return Volume.fromComposeObject(name, app.appId, app.uuid, conf);
		});

		const networks = _.mapValues(
			JSON.parse(app.networks) ?? {},
			(conf, name) => {
				return Network.fromComposeObject(name, app.appId, app.uuid, conf ?? {});
			},
		);

		const [opts, supervisorApiHost, hostnameOnHost] = await Promise.all([
			config.get('extendedEnvOptions'),
			dockerUtils
				.getNetworkGateway(constants.supervisorNetworkInterface)
				.catch(() => '127.0.0.1'),
			(async () =>
				_.trim(
					await fs.readFile(
						path.join(constants.rootMountPoint, '/etc/hostname'),
						'utf8',
					),
				))(),
		]);

		const svcOpts = {
			appName: app.name,
			supervisorApiHost,
			hostnameOnHost,
			...opts,
		};

		const supervisorMeta = await getSupervisorMetadata();

		const isService = (svc: ServiceComposeConfig) =>
			svc.labels?.['io.balena.image.class'] == null ||
			svc.labels['io.balena.image.class'] === 'service';

		const isDataStore = (svc: ServiceComposeConfig) =>
			svc.labels?.['io.balena.image.store'] == null ||
			svc.labels['io.balena.image.store'] === 'data';

		const isSupervisor = (svc: ServiceComposeConfig) =>
			app.uuid === supervisorMeta.uuid &&
			(svc.serviceName === supervisorMeta.serviceName ||
				// keep compatibility with older supervisor releases
				svc.serviceName === 'main');

		// In the db, the services are an array, but here we switch them to an
		// object so that they are consistent
		const services: Service[] = await Promise.all(
			JSON.parse(app.services ?? [])
				.filter(
					// For the host app, `io.balena.image.*` labels indicate special way
					// to install the service image, so we ignore those we don't know how to
					// handle yet. If a user app adds the labels, we treat those services
					// just as any other
					(svc: ServiceComposeConfig) =>
						!app.isHost || (isService(svc) && isDataStore(svc)),
				)
				// Ignore the supervisor service itself from the target state for now
				// until the supervisor can update itself
				.filter((svc: ServiceComposeConfig) => !isSupervisor(svc))
				.map(async (svc: ServiceComposeConfig) => {
					// Try to fill the image id if the image is downloaded
					let imageInfo: ImageInspectInfo | undefined;
					try {
						imageInfo = await imageManager.inspectByName(svc.image);
					} catch (e) {
						if (!NotFoundError(e)) {
							throw e;
						}
					}

					const thisSvcOpts = {
						...svcOpts,
						imageInfo,
						serviceName: svc.serviceName,
					};

					// FIXME: Typings for DeviceMetadata
					return await Service.fromComposeObject(
						svc,
						(thisSvcOpts as unknown) as DeviceMetadata,
					);
				}),
		);

		return new App(
			{
				appId: app.appId,
				appUuid: app.uuid,
				commit: app.commit,
				appName: app.name,
				source: app.source,
				isHost: app.isHost,
				services,
				volumes,
				networks,
			},
			true,
		);
	}
}

export default App;
