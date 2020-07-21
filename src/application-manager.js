import * as Promise from 'bluebird';
import * as _ from 'lodash';
import * as EventEmitter from 'events';
import * as express from 'express';
import * as bodyParser from 'body-parser';

import * as constants from './lib/constants';
import { log } from './lib/supervisor-console';
import * as config from './config';
import * as logger from './logger';

import { validateTargetContracts } from './lib/contracts';
import { docker } from './lib/docker-utils';
import { LocalModeManager } from './local-mode';
import * as updateLock from './lib/update-lock';
import { checkTruthy, checkInt, checkString } from './lib/validation';
import {
	ContractViolationError,
	InternalInconsistencyError,
} from './lib/errors';

import * as dbFormat from './device-state/db-format';

import * as Images from './compose/images';
import { Network } from './compose/network';
import * as networkManager from './compose/network-manager';
import * as volumeManager from './compose/volume-manager';
import * as serviceManager from './compose/service-manager';
import * as compositionSteps from './compose/composition-steps';

import { Proxyvisor } from './proxyvisor';

import { createV1Api } from './device-api/v1';
import { createV2Api } from './device-api/v2';
import { serviceAction } from './device-api/common';

import * as deviceState from './device-state';
import * as apiBinder from './api-binder';

import * as db from './db';

// TODO: move this to an Image class?
const imageForService = (service) => ({
	name: service.imageName,
	appId: service.appId,
	serviceId: service.serviceId,
	serviceName: service.serviceName,
	imageId: service.imageId,
	releaseId: service.releaseId,
	dependent: 0,
});

const fetchAction = (service) => ({
	action: 'fetch',
	image: imageForService(service),
	serviceId: service.serviceId,
	serviceName: service.serviceName,
});

// TODO: implement additional v2 endpoints
// Some v1 endpoins only work for single-container apps as they assume the app has a single service.
const createApplicationManagerRouter = function (applications) {
	const router = express.Router();
	router.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
	router.use(bodyParser.json({ limit: '10mb' }));

	createV1Api(router, applications);
	createV2Api(router, applications);

	router.use(applications.proxyvisor.router);

	return router;
};

export class ApplicationManager extends EventEmitter {
	constructor() {
		super();

		this.serviceAction = serviceAction;
		this.imageForService = imageForService;
		this.fetchAction = fetchAction;

		this._strategySteps = {
			'download-then-kill'(
				current,
				target,
				needsDownload,
				dependenciesMetForKill,
			) {
				if (needsDownload) {
					return fetchAction(target);
				} else if (dependenciesMetForKill()) {
					// We only kill when dependencies are already met, so that we minimize downtime
					return serviceAction('kill', target.serviceId, current, target);
				} else {
					return { action: 'noop' };
				}
			},
			'kill-then-download'(current, target) {
				return serviceAction('kill', target.serviceId, current, target);
			},
			'delete-then-download'(current, target) {
				return serviceAction('kill', target.serviceId, current, target);
			},
			'hand-over'(
				current,
				target,
				needsDownload,
				dependenciesMetForStart,
				dependenciesMetForKill,
				needsSpecialKill,
				timeout,
			) {
				if (needsDownload) {
					return fetchAction(target);
				} else if (needsSpecialKill && dependenciesMetForKill()) {
					return serviceAction('kill', target.serviceId, current, target);
				} else if (dependenciesMetForStart()) {
					return serviceAction('handover', target.serviceId, current, target, {
						timeout,
					});
				} else {
					return { action: 'noop' };
				}
			},
		};

		this.reportCurrentState = this.reportCurrentState.bind(this);
		this.init = this.init.bind(this);
		this.getStatus = this.getStatus.bind(this);
		this.getDependentState = this.getDependentState.bind(this);
		this.getCurrentForComparison = this.getCurrentForComparison.bind(this);
		this.getCurrentApp = this.getCurrentApp.bind(this);
		this.getTargetApp = this.getTargetApp.bind(this);
		this.compareServicesForUpdate = this.compareServicesForUpdate.bind(this);
		this.compareNetworksForUpdate = this.compareNetworksForUpdate.bind(this);
		this.compareVolumesForUpdate = this.compareVolumesForUpdate.bind(this);
		this._nextStepsForNetwork = this._nextStepsForNetwork.bind(this);
		this._nextStepForService = this._nextStepForService.bind(this);
		this._nextStepsForAppUpdate = this._nextStepsForAppUpdate.bind(this);
		this.setTargetVolatileForService = this.setTargetVolatileForService.bind(
			this,
		);
		this.clearTargetVolatileForServices = this.clearTargetVolatileForServices.bind(
			this,
		);
		this.getTargetApps = this.getTargetApps.bind(this);
		this.getDependentTargets = this.getDependentTargets.bind(this);
		this._compareImages = this._compareImages.bind(this);
		this._inferNextSteps = this._inferNextSteps.bind(this);
		this.stopAll = this.stopAll.bind(this);
		this._lockingIfNecessary = this._lockingIfNecessary.bind(this);
		this.executeStepAction = this.executeStepAction.bind(this);
		this.getExtraStateForComparison = this.getExtraStateForComparison.bind(
			this,
		);
		this.getRequiredSteps = this.getRequiredSteps.bind(this);
		this.serviceNameFromId = this.serviceNameFromId.bind(this);
		this.removeAllVolumesForApp = this.removeAllVolumesForApp.bind(this);
		this.localModeSwitchCompletion = this.localModeSwitchCompletion.bind(this);
		this.reportOptionalContainers = this.reportOptionalContainers.bind(this);
		this.deviceState = deviceState;
		this.apiBinder = apiBinder;

		this.proxyvisor = new Proxyvisor({
			applications: this,
		});
		this.localModeManager = new LocalModeManager();
		this.timeSpentFetching = 0;
		this.fetchesInProgress = 0;
		this._targetVolatilePerImageId = {};
		this._containerStarted = {};

		this.actionExecutors = compositionSteps.getExecutors({
			lockFn: this._lockingIfNecessary,
			applications: this,
			callbacks: {
				containerStarted: (id) => {
					this._containerStarted[id] = true;
				},
				containerKilled: (id) => {
					delete this._containerStarted[id];
				},
				fetchStart: () => {
					this.fetchesInProgress += 1;
				},
				fetchEnd: () => {
					this.fetchesInProgress -= 1;
				},
				fetchTime: (time) => {
					this.timeSpentFetching += time;
				},
				stateReport: (state) => this.reportCurrentState(state),
				bestDeltaSource: this.bestDeltaSource,
			},
		});
		this.validActions = _.keys(this.actionExecutors).concat(
			this.proxyvisor.validActions,
		);
		this.router = createApplicationManagerRouter(this);
		Images.on('change', this.reportCurrentState);
		serviceManager.on('change', this.reportCurrentState);
	}

	reportCurrentState(data) {
		return this.emit('change', data);
	}

	async init() {
		await Images.initialized;
		await Images.cleanupDatabase();
		const cleanup = () => {
			return docker.listContainers({ all: true }).then((containers) => {
				return logger.clearOutOfDateDBLogs(_.map(containers, 'Id'));
			});
		};
		// Rather than relying on removing out of date database entries when we're no
		// longer using them, set a task that runs periodically to clear out the database
		// This has the advantage that if for some reason a container is removed while the
		// supervisor is down, we won't have zombie entries in the db

		// Once a day
		setInterval(cleanup, 1000 * 60 * 60 * 24);
		// But also run it in on startup
		await cleanup();
		await this.localModeManager.init();
		await serviceManager.attachToRunning();
		await serviceManager.listenToEvents();
	}

	// Returns the status of applications and their services
	getStatus() {
		return Promise.join(
			serviceManager.getStatus(),
			Images.getStatus(),
			config.get('currentCommit'),
			function (services, images, currentCommit) {
				const apps = {};
				const dependent = {};
				let releaseId = null;
				const creationTimesAndReleases = {};
				// We iterate over the current running services and add them to the current state
				// of the app they belong to.
				for (const service of services) {
					const { appId, imageId } = service;
					if (apps[appId] == null) {
						apps[appId] = {};
					}
					creationTimesAndReleases[appId] = {};
					if (apps[appId].services == null) {
						apps[appId].services = {};
					}
					// We only send commit if all services have the same release, and it matches the target release
					if (releaseId == null) {
						({ releaseId } = service);
					} else if (releaseId !== service.releaseId) {
						releaseId = false;
					}
					if (imageId == null) {
						throw new InternalInconsistencyError(
							`imageId not defined in ApplicationManager.getStatus: ${service}`,
						);
					}
					if (apps[appId].services[imageId] == null) {
						apps[appId].services[imageId] = _.pick(service, [
							'status',
							'releaseId',
						]);
						creationTimesAndReleases[appId][imageId] = _.pick(service, [
							'createdAt',
							'releaseId',
						]);
						apps[appId].services[imageId].download_progress = null;
					} else {
						// There's two containers with the same imageId, so this has to be a handover
						apps[appId].services[imageId].releaseId = _.minBy(
							[creationTimesAndReleases[appId][imageId], service],
							'createdAt',
						).releaseId;
						apps[appId].services[imageId].status = 'Handing over';
					}
				}

				for (const image of images) {
					const { appId } = image;
					if (!image.dependent) {
						if (apps[appId] == null) {
							apps[appId] = {};
						}
						if (apps[appId].services == null) {
							apps[appId].services = {};
						}
						if (apps[appId].services[image.imageId] == null) {
							apps[appId].services[image.imageId] = _.pick(image, [
								'status',
								'releaseId',
							]);
							apps[appId].services[image.imageId].download_progress =
								image.downloadProgress;
						}
					} else if (image.imageId != null) {
						if (dependent[appId] == null) {
							dependent[appId] = {};
						}
						if (dependent[appId].images == null) {
							dependent[appId].images = {};
						}
						dependent[appId].images[image.imageId] = _.pick(image, ['status']);
						dependent[appId].images[image.imageId].download_progress =
							image.downloadProgress;
					} else {
						log.debug('Ignoring legacy dependent image', image);
					}
				}

				return { local: apps, dependent, commit: currentCommit };
			},
		);
	}

	getDependentState() {
		return this.proxyvisor.getCurrentStates();
	}

	_buildApps(services, networks, volumes, currentCommit) {
		/** @type {Dictionary<any>} */
		const apps = {};

		// We iterate over the current running services and add them to the current state
		// of the app they belong to.
		for (const service of services) {
			const { appId } = service;
			if (apps[appId] == null) {
				apps[appId] = { appId, services: [], volumes: {}, networks: {} };
			}
			apps[appId].services.push(service);
		}

		for (const network of networks) {
			const { appId } = network;
			if (apps[appId] == null) {
				apps[appId] = { appId, services: [], volumes: {}, networks: {} };
			}
			apps[appId].networks[network.name] = network;
		}

		for (const volume of volumes) {
			const { appId } = volume;
			if (apps[appId] == null) {
				apps[appId] = { appId, services: [], volumes: {}, networks: {} };
			}
			apps[appId].volumes[volume.name] = volume;
		}

		// multi-app warning!
		// This is just wrong on every level
		_.each(apps, (app) => {
			app.commit = currentCommit;
		});

		return apps;
	}

	getCurrentForComparison() {
		return Promise.join(
			serviceManager.getAll(),
			networkManager.getAll(),
			volumeManager.getAll(),
			config.get('currentCommit'),
			this._buildApps,
		);
	}

	getCurrentApp(appId) {
		return Promise.join(
			serviceManager.getAllByAppId(appId),
			networkManager.getAllByAppId(appId),
			volumeManager.getAllByAppId(appId),
			config.get('currentCommit'),
			this._buildApps,
		).get(appId);
	}

	getTargetApp(appId) {
		return dbFormat.getApp(appId);
	}

	// Compares current and target services and returns a list of service pairs to be updated/removed/installed.
	// The returned list is an array of objects where the "current" and "target" properties define the update pair, and either can be null
	// (in the case of an install or removal).
	compareServicesForUpdate(currentServices, targetServices, containerIds) {
		const removePairs = [];
		const installPairs = [];
		const updatePairs = [];
		const targetServiceIds = _.map(targetServices, 'serviceId');
		const currentServiceIds = _.uniq(_.map(currentServices, 'serviceId'));

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
		const currentServicesPerId = {};
		const targetServicesPerId = _.keyBy(targetServices, 'serviceId');
		for (const serviceId of toBeMaybeUpdated) {
			const currentServiceContainers = _.filter(currentServices, { serviceId });
			if (currentServiceContainers.length > 1) {
				currentServicesPerId[serviceId] = _.maxBy(
					currentServiceContainers,
					'createdAt',
				);

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

		// Returns true if a service matches its target except it should be running and it is not, but we've
		// already started it before. In this case it means it just exited so we don't want to start it again.
		const alreadyStarted = (serviceId) => {
			return (
				currentServicesPerId[serviceId].isEqualExceptForRunningState(
					targetServicesPerId[serviceId],
					containerIds,
				) &&
				targetServicesPerId[serviceId].config.running &&
				this._containerStarted[currentServicesPerId[serviceId].containerId]
			);
		};

		const needUpdate = _.filter(
			toBeMaybeUpdated,
			(serviceId) =>
				!currentServicesPerId[serviceId].isEqual(
					targetServicesPerId[serviceId],
					containerIds,
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

	_compareNetworksOrVolumesForUpdate(_model, { current, target }) {
		const outputPairs = [];
		const currentNames = _.keys(current);
		const targetNames = _.keys(target);

		const toBeRemoved = _.difference(currentNames, targetNames);
		for (const name of toBeRemoved) {
			outputPairs.push({ current: current[name], target: null });
		}

		const toBeInstalled = _.difference(targetNames, currentNames);
		for (const name of toBeInstalled) {
			outputPairs.push({ current: null, target: target[name] });
		}

		const toBeUpdated = _.filter(
			_.intersection(targetNames, currentNames),
			(name) => !current[name].isEqualConfig(target[name]),
		);
		for (const name of toBeUpdated) {
			outputPairs.push({
				current: current[name],
				target: target[name],
			});
		}

		return outputPairs;
	}

	compareNetworksForUpdate({ current, target }) {
		return this._compareNetworksOrVolumesForUpdate(networkManager, {
			current,
			target,
		});
	}

	compareVolumesForUpdate({ current, target }) {
		return this._compareNetworksOrVolumesForUpdate(volumeManager, {
			current,
			target,
		});
	}

	// Checks if a service is using a network or volume that is about to be updated
	_hasCurrentNetworksOrVolumes(service, networkPairs, volumePairs) {
		if (service == null) {
			return false;
		}
		const hasNetwork = _.some(
			networkPairs,
			(pair) =>
				`${service.appId}_${pair.current?.name}` === service.networkMode,
		);
		if (hasNetwork) {
			return true;
		}
		const hasVolume = _.some(service.volumes, function (volume) {
			const name = _.split(volume, ':')[0];
			return _.some(
				volumePairs,
				(pair) => `${service.appId}_${pair.current?.name}` === name,
			);
		});
		return hasVolume;
	}

	// TODO: account for volumes-from, networks-from, links, etc
	// TODO: support networks instead of only networkMode
	_dependenciesMetForServiceStart(
		target,
		networkPairs,
		volumePairs,
		pendingPairs,
	) {
		// for dependsOn, check no install or update pairs have that service
		const dependencyUnmet = _.some(target.dependsOn, (dependency) =>
			_.some(pendingPairs, (pair) => pair.target?.serviceName === dependency),
		);
		if (dependencyUnmet) {
			return false;
		}
		// for networks and volumes, check no network pairs have that volume name
		if (
			_.some(
				networkPairs,
				(pair) => `${target.appId}_${pair.target?.name}` === target.networkMode,
			)
		) {
			return false;
		}
		const volumeUnmet = _.some(target.volumes, function (volumeDefinition) {
			const [sourceName, destName] = volumeDefinition.split(':');
			if (destName == null) {
				// If this is not a named volume, ignore it
				return false;
			}
			return _.some(
				volumePairs,
				(pair) => `${target.appId}_${pair.target?.name}` === sourceName,
			);
		});
		return !volumeUnmet;
	}

	// Unless the update strategy requires an early kill (i.e. kill-then-download, delete-then-download), we only want
	// to kill a service once the images for the services it depends on have been downloaded, so as to minimize
	// downtime (but not block the killing too much, potentially causing a deadlock)
	_dependenciesMetForServiceKill(
		target,
		targetApp,
		availableImages,
		localMode,
	) {
		// Because we only check for an image being available, in local mode this will always
		// be the case, so return true regardless. If this function ever checks for anything else,
		// we'll need to change the logic here
		if (localMode) {
			return true;
		}
		if (target.dependsOn != null) {
			for (const dependency of target.dependsOn) {
				const dependencyService = _.find(targetApp.services, {
					serviceName: dependency,
				});
				if (
					!_.some(
						availableImages,
						(image) =>
							image.dockerImageId === dependencyService.image ||
							Images.isSameImage(image, { name: dependencyService.imageName }),
					)
				) {
					return false;
				}
			}
		}
		return true;
	}

	_nextStepsForNetworkOrVolume(
		{ current, target },
		currentApp,
		changingPairs,
		dependencyComparisonFn,
		model,
	) {
		// Check none of the currentApp.services use this network or volume
		if (current != null) {
			const dependencies = _.filter(currentApp.services, (service) =>
				dependencyComparisonFn(service, current),
			);
			if (_.isEmpty(dependencies)) {
				if (model === 'network') {
					return [{ action: 'removeNetwork', current }];
				}
				return [];
			} else {
				// If the current update doesn't require killing the services that use this network/volume,
				// we have to kill them before removing the network/volume (e.g. when we're only updating the network config)
				const steps = [];
				for (const dependency of dependencies) {
					if (
						dependency.status !== 'Stopping' &&
						!_.some(changingPairs, { serviceId: dependency.serviceId })
					) {
						steps.push(serviceAction('kill', dependency.serviceId, dependency));
					}
				}
				return steps;
			}
		} else if (target != null) {
			const action = model === 'network' ? 'createNetwork' : 'createVolume';
			return [{ action, target }];
		}
	}

	_nextStepsForNetwork({ current, target }, currentApp, changingPairs) {
		const dependencyComparisonFn = (service, curr) =>
			service.config.networkMode === `${service.appId}_${curr?.name}`;

		return this._nextStepsForNetworkOrVolume(
			{ current, target },
			currentApp,
			changingPairs,
			dependencyComparisonFn,
			'network',
		);
	}

	_nextStepsForVolume({ current, target }, currentApp, changingPairs) {
		// Check none of the currentApp.services use this network or volume
		const dependencyComparisonFn = (service, curr) =>
			_.some(service.config.volumes, function (volumeDefinition) {
				const [sourceName, destName] = volumeDefinition.split(':');
				return (
					destName != null && sourceName === `${service.appId}_${curr?.name}`
				);
			});
		return this._nextStepsForNetworkOrVolume(
			{ current, target },
			currentApp,
			changingPairs,
			dependencyComparisonFn,
			'volume',
		);
	}

	// Infers steps that do not require creating a new container
	_updateContainerStep(current, target) {
		if (
			current.releaseId !== target.releaseId ||
			current.imageId !== target.imageId
		) {
			return serviceAction('updateMetadata', target.serviceId, current, target);
		} else if (target.config.running) {
			return serviceAction('start', target.serviceId, current, target);
		} else {
			return serviceAction('stop', target.serviceId, current, target);
		}
	}

	_fetchOrStartStep(current, target, needsDownload, dependenciesMetForStart) {
		if (needsDownload) {
			return fetchAction(target);
		} else if (dependenciesMetForStart()) {
			return serviceAction('start', target.serviceId, current, target);
		} else {
			return null;
		}
	}

	_nextStepForService(
		{ current, target },
		updateContext,
		localMode,
		containerIds,
	) {
		const {
			targetApp,
			networkPairs,
			volumePairs,
			installPairs,
			updatePairs,
			availableImages,
			downloading,
		} = updateContext;
		if (current?.status === 'Stopping') {
			// There is already a kill step in progress for this service, so we wait
			return { action: 'noop' };
		}

		if (current?.status === 'Dead') {
			// Dead containers have to be removed
			return serviceAction('remove', current.serviceId, current);
		}

		let needsDownload = false;
		// Don't attempt to fetch any images in local mode, they should already be there
		if (!localMode) {
			needsDownload = !_.some(
				availableImages,
				(image) =>
					image.dockerImageId === target?.config.image ||
					Images.isSameImage(image, { name: target.imageName }),
			);
		}

		// This service needs an image download but it's currently downloading, so we wait
		if (needsDownload && downloading.includes(target?.imageId)) {
			return { action: 'noop' };
		}

		const dependenciesMetForStart = () => {
			return this._dependenciesMetForServiceStart(
				target,
				networkPairs,
				volumePairs,
				installPairs.concat(updatePairs),
			);
		};
		const dependenciesMetForKill = () => {
			return (
				!needsDownload &&
				this._dependenciesMetForServiceKill(
					target,
					targetApp,
					availableImages,
					localMode,
				)
			);
		};

		// If the service is using a network or volume that is being updated, we need to kill it
		// even if its strategy is handover
		const needsSpecialKill = this._hasCurrentNetworksOrVolumes(
			current,
			networkPairs,
			volumePairs,
		);

		if (current?.isEqualConfig(target, containerIds)) {
			// We're only stopping/starting it
			return this._updateContainerStep(current, target);
		} else if (current == null) {
			// Either this is a new service, or the current one has already been killed
			return this._fetchOrStartStep(
				current,
				target,
				needsDownload,
				dependenciesMetForStart,
			);
		} else {
			let strategy = checkString(
				target.config.labels['io.balena.update.strategy'],
			);
			const validStrategies = [
				'download-then-kill',
				'kill-then-download',
				'delete-then-download',
				'hand-over',
			];
			if (!_.includes(validStrategies, strategy)) {
				strategy = 'download-then-kill';
			}
			const timeout = checkInt(
				target.config.labels['io.balena.update.handover-timeout'],
			);
			return this._strategySteps[strategy](
				current,
				target,
				needsDownload,
				dependenciesMetForStart,
				dependenciesMetForKill,
				needsSpecialKill,
				timeout,
			);
		}
	}

	_nextStepsForAppUpdate(
		currentApp,
		targetApp,
		localMode,
		containerIds,
		availableImages,
		downloading,
	) {
		if (availableImages == null) {
			availableImages = [];
		}
		if (downloading == null) {
			downloading = [];
		}
		const emptyApp = { services: [], volumes: {}, networks: {} };
		if (targetApp == null) {
			targetApp = emptyApp;
		} else {
			// Create the default network for the target app
			if (targetApp.networks['default'] == null) {
				targetApp.networks['default'] = Network.fromComposeObject(
					'default',
					targetApp.appId,
					{},
				);
			}
		}
		if (currentApp == null) {
			currentApp = emptyApp;
		}
		if (
			currentApp.services?.length === 1 &&
			targetApp.services?.length === 1 &&
			targetApp.services[0].serviceName ===
				currentApp.services[0].serviceName &&
			checkTruthy(
				currentApp.services[0].config.labels['io.balena.legacy-container'],
			)
		) {
			// This is a legacy preloaded app or container, so we didn't have things like serviceId.
			// We hack a few things to avoid an unnecessary restart of the preloaded app
			// (but ensuring it gets updated if it actually changed)
			targetApp.services[0].config.labels['io.balena.legacy-container'] =
				currentApp.services[0].config.labels['io.balena.legacy-container'];
			targetApp.services[0].config.labels['io.balena.service-id'] =
				currentApp.services[0].config.labels['io.balena.service-id'];
			targetApp.services[0].serviceId = currentApp.services[0].serviceId;
		}

		const networkPairs = this.compareNetworksForUpdate({
			current: currentApp.networks,
			target: targetApp.networks,
		});
		const volumePairs = this.compareVolumesForUpdate({
			current: currentApp.volumes,
			target: targetApp.volumes,
		});
		const {
			removePairs,
			installPairs,
			updatePairs,
		} = this.compareServicesForUpdate(
			currentApp.services,
			targetApp.services,
			containerIds,
		);
		let steps = [];
		// All removePairs get a 'kill' action
		for (const pair of removePairs) {
			if (pair.current.status !== 'Stopping') {
				steps.push(serviceAction('kill', pair.current.serviceId, pair.current));
			} else {
				steps.push({ action: 'noop' });
			}
		}

		// next step for install pairs in download - start order, but start requires dependencies, networks and volumes met
		// next step for update pairs in order by update strategy. start requires dependencies, networks and volumes met.
		for (const pair of installPairs.concat(updatePairs)) {
			const step = this._nextStepForService(
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
				containerIds,
			);
			if (step != null) {
				steps.push(step);
			}
		}
		// next step for network pairs - remove requires services killed, create kill if no pairs or steps affect that service
		for (const pair of networkPairs) {
			const pairSteps = this._nextStepsForNetwork(
				pair,
				currentApp,
				removePairs.concat(updatePairs),
			);
			steps = steps.concat(pairSteps);
		}
		// next step for volume pairs - remove requires services killed, create kill if no pairs or steps affect that service
		for (const pair of volumePairs) {
			const pairSteps = this._nextStepsForVolume(
				pair,
				currentApp,
				removePairs.concat(updatePairs),
			);
			steps = steps.concat(pairSteps);
		}

		if (
			_.isEmpty(steps) &&
			targetApp.commit != null &&
			currentApp.commit !== targetApp.commit
		) {
			steps.push({
				action: 'updateCommit',
				target: targetApp.commit,
			});
		}

		const appId = targetApp.appId ?? currentApp.appId;
		return _.map(steps, (step) => _.assign({}, step, { appId }));
	}

	async setTarget(apps, dependent, source, maybeTrx) {
		const setInTransaction = async (filtered, trx) => {
			await dbFormat.setApps(filtered, source, trx);
			await trx('app')
				.where({ source })
				.whereNotIn(
					'appId',
					// Use apps here, rather than filteredApps, to
					// avoid removing a release from the database
					// without an application to replace it.
					// Currently this will only happen if the release
					// which would replace it fails a contract
					// validation check
					_.map(apps, (_v, appId) => checkInt(appId)),
				)
				.del();

			await this.proxyvisor.setTargetInTransaction(dependent, trx);
		};

		// We look at the container contracts here, as if we
		// cannot run the release, we don't want it to be added
		// to the database, overwriting the current release. This
		// is because if we just reject the release, but leave it
		// in the db, if for any reason the current state stops
		// running, we won't restart it, leaving the device
		// useless - The exception to this rule is when the only
		// failing services are marked as optional, then we
		// filter those out and add the target state to the database
		/** @type { { [appName: string]: string[]; } } */
		const contractViolators = {};
		const fulfilledContracts = validateTargetContracts(apps);
		const filteredApps = _.cloneDeep(apps);
		_.each(
			fulfilledContracts,
			(
				{ valid, unmetServices, fulfilledServices, unmetAndOptional },
				appId,
			) => {
				if (!valid) {
					contractViolators[apps[appId].name] = unmetServices;
					return delete filteredApps[appId];
				} else {
					// valid is true, but we could still be missing
					// some optional containers, and need to filter
					// these out of the target state
					filteredApps[appId].services = _.pickBy(
						filteredApps[appId].services,
						({ serviceName }) => fulfilledServices.includes(serviceName),
					);
					if (unmetAndOptional.length !== 0) {
						return this.reportOptionalContainers(unmetAndOptional);
					}
				}
			},
		);
		let promise;
		if (maybeTrx != null) {
			promise = setInTransaction(filteredApps, maybeTrx);
		} else {
			promise = db.transaction(setInTransaction);
		}
		try {
			await promise;
			this._targetVolatilePerImageId = {};
		} finally {
			if (!_.isEmpty(contractViolators)) {
				throw new ContractViolationError(contractViolators);
			}
		}
	}

	setTargetVolatileForService(imageId, target) {
		if (this._targetVolatilePerImageId[imageId] == null) {
			this._targetVolatilePerImageId[imageId] = {};
		}
		return _.assign(this._targetVolatilePerImageId[imageId], target);
	}

	clearTargetVolatileForServices(imageIds) {
		return imageIds.map(
			(imageId) => (this._targetVolatilePerImageId[imageId] = {}),
		);
	}

	async getTargetApps() {
		const apps = await dbFormat.getApps();

		_.each(apps, (app) => {
			if (!_.isEmpty(app.services)) {
				app.services = _.mapValues(app.services, (svc) => {
					if (this._targetVolatilePerImageId[svc.imageId] != null) {
						return {
							...svc,
							...this._targetVolatilePerImageId[svc.imageId],
						};
					}
					return svc;
				});
			}
		});

		return apps;
	}

	getDependentTargets() {
		return this.proxyvisor.getTarget();
	}

	bestDeltaSource(image, available) {
		if (!image.dependent) {
			for (const availableImage of available) {
				if (
					availableImage.serviceName === image.serviceName &&
					availableImage.appId === image.appId
				) {
					return availableImage.name;
				}
			}
		}
		for (const availableImage of available) {
			if (availableImage.appId === image.appId) {
				return availableImage.name;
			}
		}
		return null;
	}

	// returns:
	// imagesToRemove: images that
	// - are not used in the current state, and
	// - are not going to be used in the target state, and
	// - are not needed for delta source / pull caching or would be used for a service with delete-then-download as strategy
	// imagesToSave: images that
	// - are locally available (i.e. an image with the same digest exists)
	// - are not saved to the DB with all their metadata (serviceId, serviceName, etc)
	_compareImages(current, target, available, localMode) {
		const allImagesForTargetApp = (app) => _.map(app.services, imageForService);
		const allImagesForCurrentApp = (app) =>
			_.map(app.services, function (service) {
				const img =
					_.find(available, {
						dockerImageId: service.config.image,
						imageId: service.imageId,
					}) ?? _.find(available, { dockerImageId: service.config.image });
				return _.omit(img, ['dockerImageId', 'id']);
			});
		const allImageDockerIdsForTargetApp = (app) =>
			_(app.services)
				.map((svc) => [svc.imageName, svc.config.image])
				.filter((img) => img[1] != null)
				.value();

		const availableWithoutIds = _.map(available, (image) =>
			_.omit(image, ['dockerImageId', 'id']),
		);
		const currentImages = _.flatMap(current.local.apps, allImagesForCurrentApp);
		const targetImages = _.flatMap(target.local.apps, allImagesForTargetApp);
		const targetImageDockerIds = _.fromPairs(
			_.flatMap(target.local.apps, allImageDockerIdsForTargetApp),
		);

		const availableAndUnused = _.filter(
			availableWithoutIds,
			(image) =>
				!_.some(currentImages.concat(targetImages), (imageInUse) =>
					_.isEqual(image, imageInUse),
				),
		);

		const imagesToDownload = _.filter(
			targetImages,
			(targetImage) =>
				!_.some(available, (availableImage) =>
					Images.isSameImage(availableImage, targetImage),
				),
		);
		// Images that are available but we don't have them in the DB with the exact metadata:
		let imagesToSave = [];
		if (!localMode) {
			imagesToSave = _.filter(targetImages, function (targetImage) {
				const isActuallyAvailable = _.some(available, function (
					availableImage,
				) {
					if (Images.isSameImage(availableImage, targetImage)) {
						return true;
					}
					if (
						availableImage.dockerImageId ===
						targetImageDockerIds[targetImage.name]
					) {
						return true;
					}
					return false;
				});
				const isNotSaved = !_.some(availableWithoutIds, (img) =>
					_.isEqual(img, targetImage),
				);
				return isActuallyAvailable && isNotSaved;
			});
		}

		const deltaSources = _.map(imagesToDownload, (image) => {
			return this.bestDeltaSource(image, available);
		});
		const proxyvisorImages = this.proxyvisor.imagesInUse(current, target);

		const potentialDeleteThenDownload = _.filter(
			current.local.apps.services,
			(svc) =>
				svc.config.labels['io.balena.update.strategy'] ===
					'delete-then-download' && svc.status === 'Stopped',
		);

		const imagesToRemove = _.filter(
			availableAndUnused.concat(potentialDeleteThenDownload),
			function (image) {
				const notUsedForDelta = !_.includes(deltaSources, image.name);
				const notUsedByProxyvisor = !_.some(
					proxyvisorImages,
					(proxyvisorImage) =>
						Images.isSameImage(image, { name: proxyvisorImage }),
				);
				return notUsedForDelta && notUsedByProxyvisor;
			},
		);
		return { imagesToSave, imagesToRemove };
	}

	_inferNextSteps(
		cleanupNeeded,
		availableImages,
		downloading,
		supervisorNetworkReady,
		current,
		target,
		ignoreImages,
		{ localMode, delta },
		containerIds,
	) {
		const volumePromises = [];
		return Promise.try(() => {
			if (localMode) {
				ignoreImages = true;
			}
			const currentByAppId = current.local.apps ?? {};
			const targetByAppId = target.local.apps ?? {};

			// Given we need to detect when a device is moved
			// between applications, we do it this way. This code
			// is going to change to an application-manager +
			// application model, which means that we can just
			// detect when an application is no longer referenced
			// in the target state, and run the teardown that way.
			// Until then, this essentially does the same thing. We
			// check when every other part of the teardown for an
			// application has been complete, and then append the
			// volume removal steps.
			// We also don't want to remove cloud volumes when
			// switching to local mode
			// multi-app warning: this will break
			let appsForVolumeRemoval;
			if (!localMode) {
				const currentAppIds = _.keys(current.local.apps).map((n) =>
					checkInt(n),
				);
				const targetAppIds = _.keys(target.local.apps).map((n) => checkInt(n));
				appsForVolumeRemoval = _.difference(currentAppIds, targetAppIds);
			}

			let nextSteps = [];
			if (!supervisorNetworkReady) {
				// if the supervisor0 network isn't ready and there's any containers using it, we need
				// to kill them
				let containersUsingSupervisorNetwork = false;
				for (const appId of _.keys(currentByAppId)) {
					const { services } = currentByAppId[appId];
					for (const n in services) {
						if (
							checkTruthy(
								services[n].config.labels['io.balena.features.supervisor-api'],
							)
						) {
							containersUsingSupervisorNetwork = true;
							if (services[n].status !== 'Stopping') {
								nextSteps.push(
									serviceAction('kill', services[n].serviceId, services[n]),
								);
							} else {
								nextSteps.push({ action: 'noop' });
							}
						}
					}
				}
				if (!containersUsingSupervisorNetwork) {
					nextSteps.push({ action: 'ensureSupervisorNetwork' });
				}
			} else {
				if (!ignoreImages && _.isEmpty(downloading)) {
					if (cleanupNeeded) {
						nextSteps.push({ action: 'cleanup' });
					}
					const { imagesToRemove, imagesToSave } = this._compareImages(
						current,
						target,
						availableImages,
						localMode,
					);
					for (const image of imagesToSave) {
						nextSteps.push({ action: 'saveImage', image });
					}
					if (_.isEmpty(imagesToSave)) {
						for (const image of imagesToRemove) {
							nextSteps.push({ action: 'removeImage', image });
						}
					}
				}
				// If we have to remove any images, we do that before anything else
				if (_.isEmpty(nextSteps)) {
					const allAppIds = _.union(
						_.keys(currentByAppId),
						_.keys(targetByAppId),
					);
					for (const appId of allAppIds) {
						nextSteps = nextSteps.concat(
							this._nextStepsForAppUpdate(
								currentByAppId[appId],
								targetByAppId[appId],
								localMode,
								containerIds[appId],
								availableImages,
								downloading,
							),
						);
						if (_.includes(appsForVolumeRemoval, checkInt(appId))) {
							// We check if everything else has been done for
							// the old app to be removed. If it has, we then
							// remove all of the volumes
							if (_.every(nextSteps, { action: 'noop' })) {
								volumePromises.push(
									this.removeAllVolumesForApp(checkInt(appId)),
								);
							}
						}
					}
				}
			}
			const newDownloads = nextSteps.filter((s) => s.action === 'fetch').length;

			if (!ignoreImages && delta && newDownloads > 0) {
				// Check that this is not the first pull for an
				// application, as we want to download all images then
				// Otherwise we want to limit the downloading of
				// deltas to constants.maxDeltaDownloads
				const appImages = _.groupBy(availableImages, 'appId');
				let downloadsToBlock =
					downloading.length + newDownloads - constants.maxDeltaDownloads;

				nextSteps = nextSteps.filter(function (step) {
					if (step.action === 'fetch' && downloadsToBlock > 0) {
						const imagesForThisApp = appImages[step.image.appId];
						if (imagesForThisApp == null || imagesForThisApp.length === 0) {
							// There isn't a valid image for the fetch
							// step, so we keep it
							return true;
						} else {
							downloadsToBlock -= 1;
							return false;
						}
					} else {
						return true;
					}
				});
			}

			if (!ignoreImages && _.isEmpty(nextSteps) && !_.isEmpty(downloading)) {
				nextSteps.push({ action: 'noop' });
			}
			return _.uniqWith(nextSteps, _.isEqual);
		}).then((nextSteps) =>
			Promise.all(volumePromises).then(function (volSteps) {
				nextSteps = nextSteps.concat(_.flatten(volSteps));
				return nextSteps;
			}),
		);
	}

	stopAll({ force = false, skipLock = false } = {}) {
		return Promise.resolve(serviceManager.getAll())
			.map((service) => {
				return this._lockingIfNecessary(
					service.appId,
					{ force, skipLock },
					() => {
						return serviceManager
							.kill(service, { removeContainer: false, wait: true })
							.then(() => {
								delete this._containerStarted[service.containerId];
							});
					},
				);
			})
			.return();
	}

	_lockingIfNecessary(appId, { force = false, skipLock = false } = {}, fn) {
		if (skipLock) {
			return Promise.try(fn);
		}
		return config
			.get('lockOverride')
			.then((lockOverride) => lockOverride || force)
			.then((lockOverridden) =>
				updateLock.lock(appId, { force: lockOverridden }, fn),
			);
	}

	executeStepAction(step, { force = false, skipLock = false } = {}) {
		if (_.includes(this.proxyvisor.validActions, step.action)) {
			return this.proxyvisor.executeStepAction(step);
		}
		if (!_.includes(this.validActions, step.action)) {
			return Promise.reject(new Error(`Invalid action ${step.action}`));
		}
		return this.actionExecutors[step.action](
			_.merge({}, step, { force, skipLock }),
		);
	}

	getExtraStateForComparison(currentState, targetState) {
		const containerIdsByAppId = {};
		_(currentState.local.apps)
			.keys()
			.concat(_.keys(targetState.local.apps))
			.uniq()
			.each((id) => {
				const intId = checkInt(id);
				if (intId == null) {
					throw new Error(`Invalid id: ${id}`);
				}
				containerIdsByAppId[intId] = serviceManager.getContainerIdMap(intId);
			});

		return config.get('localMode').then((localMode) => {
			return Promise.props({
				cleanupNeeded: Images.isCleanupNeeded(),
				availableImages: Images.getAvailable(),
				downloading: Images.getDownloadingImageIds(),
				supervisorNetworkReady: networkManager.supervisorNetworkReady(),
				delta: config.get('delta'),
				containerIds: Promise.props(containerIdsByAppId),
				localMode,
			});
		});
	}

	getRequiredSteps(currentState, targetState, extraState, ignoreImages) {
		if (ignoreImages == null) {
			ignoreImages = false;
		}
		let {
			cleanupNeeded,
			availableImages,
			downloading,
			supervisorNetworkReady,
			delta,
			localMode,
			containerIds,
		} = extraState;
		const conf = { delta, localMode };
		if (conf.localMode) {
			cleanupNeeded = false;
		}

		return this._inferNextSteps(
			cleanupNeeded,
			availableImages,
			downloading,
			supervisorNetworkReady,
			currentState,
			targetState,
			ignoreImages,
			conf,
			containerIds,
		).then((nextSteps) => {
			if (ignoreImages && _.some(nextSteps, { action: 'fetch' })) {
				throw new Error('Cannot fetch images while executing an API action');
			}
			return this.proxyvisor
				.getRequiredSteps(
					availableImages,
					downloading,
					currentState,
					targetState,
					nextSteps,
				)
				.then((proxyvisorSteps) => nextSteps.concat(proxyvisorSteps));
		});
	}

	serviceNameFromId(serviceId) {
		return this.getTargetApps().then(function (apps) {
			// Multi-app warning!
			// We assume here that there will only be a single
			// application
			for (const appId of Object.keys(apps)) {
				const app = apps[appId];
				const service = _.find(
					app.services,
					(svc) => svc.serviceId === serviceId,
				);
				if (service?.serviceName == null) {
					throw new InternalInconsistencyError(
						`Could not find service name for id: ${serviceId}`,
					);
				}
				return service.serviceName;
			}
			throw new InternalInconsistencyError(
				`Trying to get service name with no apps: ${serviceId}`,
			);
		});
	}

	removeAllVolumesForApp(appId) {
		return volumeManager.getAllByAppId(appId).then((volumes) =>
			volumes.map((v) => ({
				action: 'removeVolume',
				current: v,
			})),
		);
	}

	localModeSwitchCompletion() {
		return this.localModeManager.switchCompletion();
	}

	reportOptionalContainers(serviceNames) {
		// Print logs to the console and dashboard, letting the
		// user know that we're not going to run certain services
		// because of their contract
		const message = `Not running containers because of contract violations: ${serviceNames.join(
			'. ',
		)}`;
		log.info(message);
		return logger.logSystemMessage(
			message,
			{},
			'optionalContainerViolation',
			true,
		);
	}
}
