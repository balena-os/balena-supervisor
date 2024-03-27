import _ from 'lodash';
import { EventEmitter } from 'events';
import type StrictEventEmitter from 'strict-event-emitter-types';

import * as config from '../config';
import type { Transaction } from '../db';
import { transaction } from '../db';
import * as logger from '../logger';
import LocalModeManager from '../local-mode';

import * as dbFormat from '../device-state/db-format';
import { validateTargetContracts } from '../lib/contracts';
import * as constants from '../lib/constants';
import { docker } from '../lib/docker-utils';
import log from '../lib/supervisor-console';
import {
	ContractViolationError,
	InternalInconsistencyError,
} from '../lib/errors';
import * as updateLock from '../lib/update-lock';
import { checkTruthy } from '../lib/validation';

import App from './app';
import type { UpdateState } from './app';
import * as volumeManager from './volume-manager';
import * as networkManager from './network-manager';
import * as serviceManager from './service-manager';
import * as imageManager from './images';
import * as commitStore from './commit';
import type Service from './service';
import type Network from './network';
import type Volume from './volume';
import { generateStep, getExecutors } from './composition-steps';

import type {
	InstancedAppState,
	TargetApps,
	DeviceLegacyReport,
	AppState,
	ServiceState,
} from '../types/state';
import type { Image } from './images';
import type { CompositionStep, CompositionStepT } from './composition-steps';

type ApplicationManagerEventEmitter = StrictEventEmitter<
	EventEmitter,
	{ change: DeviceLegacyReport }
>;
const events: ApplicationManagerEventEmitter = new EventEmitter();
export const on: (typeof events)['on'] = events.on.bind(events);
export const once: (typeof events)['once'] = events.once.bind(events);
export const removeListener: (typeof events)['removeListener'] =
	events.removeListener.bind(events);
export const removeAllListeners: (typeof events)['removeAllListeners'] =
	events.removeAllListeners.bind(events);

const localModeManager = new LocalModeManager();

export let fetchesInProgress = 0;
export let timeSpentFetching = 0;

export function resetTimeSpentFetching(value: number = 0) {
	timeSpentFetching = value;
}

const actionExecutors = getExecutors({
	callbacks: {
		fetchStart: () => {
			fetchesInProgress += 1;
		},
		fetchEnd: () => {
			fetchesInProgress -= 1;
		},
		fetchTime: (time) => {
			timeSpentFetching += time;
		},
		stateReport: (state) => {
			reportCurrentState(state);
		},
		bestDeltaSource,
	},
});

export const validActions = Object.keys(actionExecutors);

export const initialized = _.once(async () => {
	await config.initialized();
	await updateLock.initialized();

	await imageManager.cleanImageData();
	const cleanup = async () => {
		const containers = await docker.listContainers({ all: true });
		await logger.clearOutOfDateDBLogs(_.map(containers, 'Id'));
	};

	// Rather than relying on removing out of date database entries when we're no
	// longer using them, set a task that runs periodically to clear out the database
	// This has the advantage that if for some reason a container is removed while the
	// supervisor is down, we won't have zombie entries in the db

	// Once a day
	setInterval(cleanup, 1000 * 60 * 60 * 24);
	// But also run it in on startup
	await cleanup();

	await localModeManager.init();
	await serviceManager.attachToRunning();
	serviceManager.listenToEvents();

	imageManager.on('change', reportCurrentState);
	serviceManager.on('change', reportCurrentState);
});

function reportCurrentState(data?: Partial<InstancedAppState>) {
	events.emit('change', data ?? {});
}

export async function getRequiredSteps(
	currentApps: InstancedAppState,
	targetApps: InstancedAppState,
	keepImages?: boolean,
	keepVolumes?: boolean,
	force: boolean = false,
): Promise<CompositionStep[]> {
	// get some required data
	const [downloading, availableImages, { localMode, delta }] =
		await Promise.all([
			imageManager.getDownloadingImageNames(),
			imageManager.getAvailable(),
			config.getMany(['localMode', 'delta']),
		]);
	const containerIdsByAppId = getAppContainerIds(currentApps);

	// Local mode sets the image and volume retention only
	// if not explicitely set by the caller
	if (keepImages == null) {
		keepImages = localMode;
	}

	if (keepVolumes == null) {
		keepVolumes = localMode;
	}

	return await inferNextSteps(currentApps, targetApps, {
		// Images are not removed while in local mode to avoid removing the user app images
		keepImages,
		// Volumes are not removed when stopping an app when going to local mode
		keepVolumes,
		delta,
		force,
		downloading,
		availableImages,
		containerIdsByAppId,
		locksTaken: await updateLock.getServicesLockedByAppId(),
	});
}

// Calculate the required steps from the current to the target state
export async function inferNextSteps(
	currentApps: InstancedAppState,
	targetApps: InstancedAppState,
	{
		keepImages = false,
		keepVolumes = false,
		delta = true,
		force = false,
		downloading = [] as UpdateState['downloading'],
		availableImages = [] as UpdateState['availableImages'],
		containerIdsByAppId = {} as {
			[appId: number]: UpdateState['containerIds'];
		},
		locksTaken = new updateLock.LocksTakenMap(),
	} = {},
) {
	const currentAppIds = Object.keys(currentApps).map((i) => parseInt(i, 10));
	const targetAppIds = Object.keys(targetApps).map((i) => parseInt(i, 10));

	let steps: CompositionStep[] = [];

	// First check if we need to create the supervisor network
	if (!(await networkManager.supervisorNetworkReady())) {
		// If we do need to create it, we first need to kill any services using the api
		const killSteps = steps.concat(killServicesUsingApi(currentApps));
		if (killSteps.length > 0) {
			steps = steps.concat(killSteps);
		} else {
			steps.push({ action: 'ensureSupervisorNetwork' });
		}
	} else {
		if (downloading.length === 0) {
			// Avoid cleaning up dangling images while purging
			if (!keepImages && (await imageManager.isCleanupNeeded())) {
				steps.push({ action: 'cleanup' });
			}

			// Detect any images which must be saved/removed, except when purging,
			// as we only want to remove containers, remove volumes, create volumes
			// anew, and start containers without images being removed.
			steps = steps.concat(
				saveAndRemoveImages(
					currentApps,
					targetApps,
					availableImages,
					keepImages,
				),
			);
		}

		// We want to remove images before moving on to anything else
		if (steps.length === 0) {
			const targetAndCurrent = _.intersection(currentAppIds, targetAppIds);
			const onlyTarget = _.difference(targetAppIds, currentAppIds);
			const onlyCurrent = _.difference(currentAppIds, targetAppIds);

			// For apps that exist in both current and target state, calculate what we need to
			// do to move to the target state
			for (const id of targetAndCurrent) {
				steps = steps.concat(
					currentApps[id].nextStepsForAppUpdate(
						{
							availableImages,
							containerIds: containerIdsByAppId[id],
							downloading,
							locksTaken,
							force,
						},
						targetApps[id],
					),
				);
			}

			// For apps in the current state but not target, we call their "destructor"
			for (const id of onlyCurrent) {
				steps = steps.concat(
					currentApps[id].stepsToRemoveApp({
						keepVolumes,
						downloading,
						containerIds: containerIdsByAppId[id],
						locksTaken,
						force,
					}),
				);
			}

			// For apps in the target state but not the current state, we generate steps to
			// create the app by mocking an existing app which contains nothing
			for (const id of onlyTarget) {
				const { appId } = targetApps[id];
				const emptyCurrent = new App(
					{
						appId,
						services: [],
						volumes: [],
						networks: [],
					},
					false,
				);
				steps = steps.concat(
					emptyCurrent.nextStepsForAppUpdate(
						{
							availableImages,
							containerIds: containerIdsByAppId[id] ?? {},
							downloading,
							locksTaken,
							force,
						},
						targetApps[id],
					),
				);
			}
		}
	}

	const newDownloads = steps.filter((s) => s.action === 'fetch').length;
	if (delta && newDownloads > 0) {
		// Check that this is not the first pull for an
		// application, as we want to download all images then
		// Otherwise we want to limit the downloading of
		// deltas to constants.maxDeltaDownloads
		const appImages = _.groupBy(availableImages, 'appId');
		let downloadsToBlock =
			downloading.length + newDownloads - constants.maxDeltaDownloads;

		steps = steps.filter((step) => {
			if (step.action === 'fetch' && downloadsToBlock > 0) {
				const imagesForThisApp =
					appImages[(step as CompositionStepT<'fetch'>).image.appId];
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

	if (steps.length === 0 && downloading.length > 0) {
		// We want to keep the state application alive
		steps.push(generateStep('noop', {}));
	}

	return steps;
}

// The following two function may look pretty odd, but after the move to uuids,
// there's a chance that the current running apps don't have a uuid set. We
// still need to be able to work on these and perform various state changes. To
// do this we try to use the UUID to group the components, and if that isn't
// available we revert to using the appIds instead
export async function getCurrentApps(): Promise<InstancedAppState> {
	const componentGroups = groupComponents(
		await serviceManager.getAll(),
		await networkManager.getAll(),
		await volumeManager.getAll(),
	);

	const images = await imageManager.getState();

	const apps: InstancedAppState = {};
	for (const strAppId of Object.keys(componentGroups)) {
		const appId = parseInt(strAppId, 10);

		// TODO: get commit and release version from container
		const commit = await commitStore.getCommitForApp(appId);

		const components = componentGroups[appId];

		// fetch the correct uuid from any component within the appId
		const uuid = [
			components.services[0]?.appUuid,
			components.volumes[0]?.appUuid,
			components.networks[0]?.appUuid,
		]
			.filter((u) => !!u)
			.shift()!;

		// If we don't have any components for this app, ignore it (this can
		// actually happen when moving between backends but maintaining UUIDs)
		if (
			!_.isEmpty(components.services) ||
			!_.isEmpty(components.volumes) ||
			!_.isEmpty(components.networks)
		) {
			const services = componentGroups[appId].services.map((s) => {
				// We get the image metadata from the image database because we cannot
				// get it from the container itself
				const imageForService = images.find(
					(img) => img.serviceName === s.serviceName && img.commit === s.commit,
				);

				s.imageName = imageForService?.name ?? s.imageName;
				return s;
			});

			apps[appId] = new App(
				{
					appId,
					appUuid: uuid,
					commit,
					services,
					networks: componentGroups[appId].networks,
					volumes: componentGroups[appId].volumes,
				},
				false,
			);
		}
	}

	return apps;
}

type AppGroup = {
	[appId: number]: {
		services: Service[];
		volumes: Volume[];
		networks: Network[];
	};
};

function groupComponents(
	services: Service[],
	networks: Network[],
	volumes: Volume[],
): AppGroup {
	const grouping: AppGroup = {};

	const everyComponent: [{ appUuid?: string; appId: number }] = [
		...services,
		...networks,
		...volumes,
	] as any;

	const allUuids: string[] = [];
	const allAppIds: number[] = [];
	everyComponent.forEach(({ appId, appUuid }) => {
		// Pre-populate the groupings
		grouping[appId] = {
			services: [],
			networks: [],
			volumes: [],
		};
		// Save all the uuids for later
		if (appUuid != null) {
			allUuids.push(appUuid);
		}
		allAppIds.push(appId);
	});

	// First we try to group everything by it's uuid, but if any component does
	// not have a uuid, we fall back to the old appId style
	if (everyComponent.length === allUuids.length) {
		const uuidGroups: { [uuid: string]: AppGroup[0] } = {};
		new Set(allUuids).forEach((uuid) => {
			const uuidServices = services.filter(
				({ appUuid: sUuid }) => uuid === sUuid,
			);
			const uuidVolumes = volumes.filter(
				({ appUuid: vUuid }) => uuid === vUuid,
			);
			const uuidNetworks = networks.filter(
				({ appUuid: nUuid }) => uuid === nUuid,
			);

			uuidGroups[uuid] = {
				services: uuidServices,
				networks: uuidNetworks,
				volumes: uuidVolumes,
			};
		});

		for (const uuid of Object.keys(uuidGroups)) {
			// There's a chance that the uuid and the appId is different, and this
			// is fine. Unfortunately we have no way of knowing which is the "real"
			// appId (that is the app id which relates to the currently joined
			// backend) so we instead just choose the first and add everything to that
			const appId =
				uuidGroups[uuid].services[0]?.appId ||
				uuidGroups[uuid].networks[0]?.appId ||
				uuidGroups[uuid].volumes[0]?.appId;
			grouping[appId] = uuidGroups[uuid];
		}
	} else {
		// Otherwise group them by appId and let the state engine match them later.
		// This will only happen once, as every target state going forward will
		// contain UUIDs, we just need to handle the initial upgrade
		const appSvcs = _.groupBy(services, 'appId');
		const appVols = _.groupBy(volumes, 'appId');
		const appNets = _.groupBy(networks, 'appId');

		_.uniq(allAppIds).forEach((appId) => {
			grouping[appId].services = grouping[appId].services.concat(
				appSvcs[appId] || [],
			);
			grouping[appId].networks = grouping[appId].networks.concat(
				appNets[appId] || [],
			);
			grouping[appId].volumes = grouping[appId].volumes.concat(
				appVols[appId] || [],
			);
		});
	}

	return grouping;
}

function killServicesUsingApi(current: InstancedAppState): CompositionStep[] {
	const steps: CompositionStep[] = [];
	_.each(current, (app) => {
		_.each(app.services, (service) => {
			const isUsingSupervisorAPI = checkTruthy(
				service.config.labels['io.balena.features.supervisor-api'],
			);
			if (!isUsingSupervisorAPI) {
				// No need to stop service as it's not using the Supervisor's API
				return steps;
			}
			if (service.status !== 'Stopping') {
				// Stop this service
				steps.push(generateStep('kill', { current: service }));
			} else if (service.status === 'Stopping') {
				// Wait for the service to finish stopping
				steps.push(generateStep('noop', {}));
			}
		});
	});
	return steps;
}

// this method is meant to be used only by device-state for applying the
// target state and not by other modules. Application changes should use
// intermediate targets to perform changes
export async function executeStep(
	step: CompositionStep,
	{ force = false } = {},
): Promise<void> {
	if (!validActions.includes(step.action)) {
		return Promise.reject(
			new InternalInconsistencyError(
				`Invalid composition step action: ${step.action}`,
			),
		);
	}

	// TODO: Find out why this needs to be cast, the typings should hold true
	await actionExecutors[step.action]({
		...step,
		force,
	} as any);
}

export async function setTarget(
	apps: TargetApps,
	source: string,
	maybeTrx?: Transaction,
) {
	const setInTransaction = async (
		$filteredApps: TargetApps,
		trx: Transaction,
	) => {
		await dbFormat.setApps($filteredApps, source, trx);
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
				Object.values(apps).map(({ id: appId }) => appId),
			)
			.del();
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
	const contractViolators: { [appName: string]: string[] } = {};
	const fulfilledContracts = validateTargetContracts(apps);
	const filteredApps = structuredClone(apps);
	_.each(
		fulfilledContracts,
		(
			{ valid, unmetServices, fulfilledServices, unmetAndOptional },
			appUuid,
		) => {
			if (!valid) {
				contractViolators[apps[appUuid].name] = unmetServices;
				return delete filteredApps[appUuid];
			} else {
				// valid is true, but we could still be missing
				// some optional containers, and need to filter
				// these out of the target state
				const [releaseUuid] = Object.keys(filteredApps[appUuid].releases);
				if (releaseUuid) {
					const services =
						filteredApps[appUuid].releases[releaseUuid].services ?? {};
					filteredApps[appUuid].releases[releaseUuid].services = _.pick(
						services,
						Object.keys(services).filter((serviceName) =>
							fulfilledServices.includes(serviceName),
						),
					);
				}

				if (unmetAndOptional.length !== 0) {
					return reportOptionalContainers(unmetAndOptional);
				}
			}
		},
	);
	let promise;
	if (maybeTrx != null) {
		promise = setInTransaction(filteredApps, maybeTrx);
	} else {
		promise = transaction((trx) => setInTransaction(filteredApps, trx));
	}
	await promise;
	if (!_.isEmpty(contractViolators)) {
		throw new ContractViolationError(contractViolators);
	}
}

export async function getTargetApps(): Promise<TargetApps> {
	return await dbFormat.getTargetJson();
}

/**
 * This is only used by the API. Do not use as the use of serviceIds is getting
 * deprecated
 *
 * @deprecated
 */
export async function serviceNameFromId(serviceId: number) {
	// We get the target here as it shouldn't matter, and getting the target is cheaper
	const targetApps = await getTargetApps();

	for (const { releases } of Object.values(targetApps)) {
		const [release] = Object.values(releases);
		const services = release?.services ?? {};
		const serviceName = Object.keys(services).find(
			(svcName) => services[svcName].id === serviceId,
		);

		if (serviceName) {
			return serviceName;
		}
	}

	throw new InternalInconsistencyError(
		`Could not find a service for id: ${serviceId}`,
	);
}

export function localModeSwitchCompletion() {
	return localModeManager.switchCompletion();
}

export function bestDeltaSource(
	image: Image,
	available: Image[],
): string | null {
	for (const availableImage of available) {
		if (
			availableImage.serviceName === image.serviceName &&
			availableImage.appId === image.appId
		) {
			return availableImage.name;
		}
	}
	return null;
}

// We need to consider images for all apps, and not app-by-app, so we handle this here,
// rather than in the App class
// TODO: This function was taken directly from the old application manager, because it's
// complex enough that it's not really worth changing this along with the rest of the
// application-manager class. We should make this function much less opaque.
// Ideally we'd have images saved against specific apps, and those apps handle the
// lifecycle of said image
function saveAndRemoveImages(
	current: InstancedAppState,
	target: InstancedAppState,
	availableImages: UpdateState['availableImages'],
	skipRemoval: boolean,
): CompositionStep[] {
	type ImageWithoutID = Omit<imageManager.Image, 'dockerImageId' | 'id'>;

	// imagesToRemove: images that
	// - are not used in the current state, and
	// - are not going to be used in the target state, and
	// - are not needed for delta source / pull caching or would be used for a service with delete-then-download as strategy
	// imagesToSave: images that
	// - are locally available (i.e. an image with the same digest exists)
	// - are not saved to the DB with all their metadata (serviceId, serviceName, etc)

	const allImageDockerIdsForTargetApp = (app: App) =>
		_(app.services)
			.map((svc) => [svc.imageName, svc.dockerImageId])
			.filter((img) => img[1] != null)
			.value();

	const availableWithoutIds: ImageWithoutID[] = availableImages.map((image) =>
		_.omit(image, ['dockerImageId', 'id']),
	);

	const currentImages = _.flatMap(current, (app) =>
		_.map(
			app.services,
			(svc) =>
				_.find(availableImages, {
					dockerImageId: svc.config.image,
					// There is no way to compare a current service to an image by
					// name, the only way to do it is by both commit and service name
					commit: svc.commit,
					serviceName: svc.serviceName,
				}) ?? _.find(availableImages, { dockerImageId: svc.config.image }),
		),
	) as imageManager.Image[];

	const targetServices = Object.values(target).flatMap((app) => app.services);
	const targetImages = targetServices.map(imageManager.imageFromService);

	const availableAndUnused = availableWithoutIds.filter(
		(image) =>
			!currentImages.concat(targetImages).some((imageInUse) => {
				return _.isEqual(image, _.omit(imageInUse, ['dockerImageId', 'id']));
			}),
	);

	const imagesToDownload = targetImages.filter(
		(targetImage) =>
			!availableImages.some((available) =>
				imageManager.isSameImage(available, targetImage),
			),
	);

	const targetImageDockerIds = _.fromPairs(
		_.flatMap(target, allImageDockerIdsForTargetApp),
	);

	// Images that are available but we don't have them in the DB with the exact metadata:
	const imagesToSave: imageManager.Image[] = targetImages.filter(
		(targetImage) => {
			const isActuallyAvailable = availableImages.some((availableImage) => {
				// There is an image with same image name or digest
				// on the database
				if (imageManager.isSameImage(availableImage, targetImage)) {
					return true;
				}
				// The database image doesn't have the same name but has
				// the same docker id as the target image
				if (
					availableImage.dockerImageId ===
					targetImageDockerIds[targetImage.name]
				) {
					return true;
				}
				return false;
			});

			// There is no image in the database with the same metadata
			const isNotSaved = !availableWithoutIds.some((img) =>
				_.isEqual(img, targetImage),
			);

			// The image is not on the database but we know it exists on the
			// engine because we could find it through inspectByName
			const isAvailableOnTheEngine = !!targetImageDockerIds[targetImage.name];

			return (
				(isActuallyAvailable && isNotSaved) ||
				(!isActuallyAvailable && isAvailableOnTheEngine)
			);
		},
	);

	// Find images that will be be used as delta sources. Any existing image for the
	// same app service is considered a delta source unless the target service has set
	// the `delete-then-download` strategy
	const deltaSources = imagesToDownload
		.filter(
			(img) =>
				// We don't need to look for delta sources for delete-then-download
				// services
				!targetServices.some(
					(svc) =>
						imageManager.isSameImage(img, imageManager.imageFromService(svc)) &&
						svc.config.labels['io.balena.update.strategy'] ===
							'delete-then-download',
				),
		)
		.map((img) => bestDeltaSource(img, availableImages))
		.filter((img) => img != null);

	const imagesToRemove = skipRemoval
		? []
		: availableAndUnused.filter((image) => !deltaSources.includes(image.name));

	return imagesToSave
		.map((image) => ({ action: 'saveImage', image }) as CompositionStep)
		.concat(imagesToRemove.map((image) => ({ action: 'removeImage', image })));
}

function getAppContainerIds(currentApps: InstancedAppState) {
	const containerIds: { [appId: number]: Dictionary<string> } = {};
	Object.keys(currentApps).forEach((appId) => {
		const intAppId = parseInt(appId, 10);
		const app = currentApps[intAppId];
		const services = app.services || ([] as Service[]);
		containerIds[intAppId] = services.reduce(
			(ids, s) => ({
				...ids,
				...(s.serviceName &&
					s.containerId && { [s.serviceName]: s.containerId }),
			}),
			{} as Dictionary<string>,
		);
	});

	return containerIds;
}

function reportOptionalContainers(serviceNames: string[]) {
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

/**
 * This will be replaced by ApplicationManager.getState, at which
 * point the only place this will be used will be in the API endpoints
 * once, the API moves to v3 or we update the endpoints to return uuids, we will
 * be able to get rid of this
 * @deprecated
 */
export async function getLegacyState() {
	const [services, images] = await Promise.all([
		serviceManager.getState(),
		imageManager.getState(),
	]);

	const apps: Dictionary<any> = {};
	let releaseId: number | boolean | null | undefined = null; // ????
	const creationTimesAndReleases: Dictionary<any> = {};
	// We iterate over the current running services and add them to the current state
	// of the app they belong to.
	for (const service of services) {
		const { appId, imageId } = service;
		if (!appId) {
			continue;
		}
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
				`imageId not defined in ApplicationManager.getLegacyApplicationsState: ${service}`,
			);
		}
		if (apps[appId].services[imageId] == null) {
			apps[appId].services[imageId] = _.pick(service, ['status', 'releaseId']);
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
	}

	return { local: apps };
}

// TODO: this function is probably more inefficient than it needs to be, since
// it tried to optimize for readability, look for a way to make it simpler
export async function getState() {
	const [services, images] = await Promise.all([
		serviceManager.getState(),
		imageManager.getState(),
	]);

	type ServiceInfo = {
		appId: number;
		appUuid: string;
		commit: string;
		serviceName: string;
		createdAt?: Date;
	} & ServiceState;

	// Get service data from images
	const stateFromImages: ServiceInfo[] = images.map(
		({
			appId,
			appUuid,
			name,
			commit,
			serviceName,
			status,
			downloadProgress,
		}) => ({
			appId,
			appUuid,
			image: name,
			commit,
			serviceName,
			status: status as string,
			...(Number.isInteger(downloadProgress) && {
				download_progress: downloadProgress,
			}),
		}),
	);

	// Get all services and augment service data from the image if any
	const stateFromServices = services
		.map(({ appId, appUuid, commit, serviceName, status, createdAt }) => [
			// Only include appUuid if is available, if not available we'll get it from the image
			{
				appId,
				...(appUuid && { appUuid }),
				commit,
				serviceName,
				status,
				createdAt,
			},
			// Get the corresponding image to augment the service data
			stateFromImages.find(
				(img) => img.serviceName === serviceName && img.commit === commit,
			),
		])
		// We cannot report services that do not have an image as the API
		// requires passing the image name
		.filter(([, img]) => !!img)
		.map(([svc, img]) => ({ ...img, ...svc }) as ServiceInfo)
		.map((svc, __, serviceList) => {
			// If the service is not running it cannot be a handover
			if (svc.status !== 'Running') {
				return svc;
			}

			// If there one or more running services with the same name and appUuid, but different
			// release, then we are still handing over so we need to report the appropriate
			// status
			const siblings = serviceList.filter(
				(s) =>
					s.appUuid === svc.appUuid &&
					s.serviceName === svc.serviceName &&
					s.status === 'Running' &&
					s.commit !== svc.commit,
			);

			// There should really be only one element on the `siblings` array, but
			// we chose the oldest service to have its status reported as 'Handing over'
			if (
				siblings.length > 0 &&
				siblings.every((s) => svc.createdAt!.getTime() < s.createdAt!.getTime())
			) {
				return { ...svc, status: 'Handing over' };
			} else if (siblings.length > 0) {
				return { ...svc, status: 'Awaiting handover' };
			}
			return svc;
		});

	const servicesToReport =
		// The full list of services is the union of images that have no container created yet
		stateFromImages
			.filter(
				(img) =>
					!stateFromServices.some(
						(svc) =>
							img.serviceName === svc.serviceName && img.commit === svc.commit,
					),
			)
			// With the services that have a container
			.concat(stateFromServices);

	// Get the list of commits for all appIds from the database
	const commitsForApp: Dictionary<string | undefined> = {};
	// Deduplicate appIds first
	await Promise.all(
		[...new Set(servicesToReport.map((svc) => svc.appId))].map(
			async (appId) => {
				commitsForApp[appId] = await commitStore.getCommitForApp(appId);
			},
		),
	);

	// Assemble the state of apps
	const state: { [appUuid: string]: AppState } = {};
	for (const {
		appId,
		appUuid,
		commit,
		serviceName,
		createdAt,
		...svc
	} of servicesToReport) {
		state[appUuid] = {
			...state[appUuid],
			// Add the release_uuid if the commit has been stored in the database
			...(commitsForApp[appId] && { release_uuid: commitsForApp[appId] }),
			releases: {
				...state[appUuid]?.releases,
				[commit]: {
					...state[appUuid]?.releases[commit],
					services: {
						...state[appUuid]?.releases[commit]?.services,
						[serviceName]: svc,
					},
				},
			},
		};
	}
	return state;
}
