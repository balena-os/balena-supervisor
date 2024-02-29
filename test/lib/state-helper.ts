import App from '~/src/compose/app';
import * as imageManager from '~/src/compose/images';
import type { Image } from '~/src/compose/images';
import Network from '~/src/compose/network';
import Service from '~/src/compose/service';
import type { ServiceComposeConfig } from '~/src/compose/types/service';
import type Volume from '~/src/compose/volume';
import type {
	CompositionStep,
	CompositionStepAction,
} from '~/src/compose/composition-steps';
import type { InstancedAppState } from '~/src/types/state';

export const DEFAULT_NETWORK = Network.fromComposeObject(
	'default',
	1,
	'appuuid',
	{},
);

export async function createService(
	{
		appId = 1,
		appUuid = 'appuuid',
		serviceName = 'main',
		commit = 'main-commit',
		...conf
	} = {} as Partial<ServiceComposeConfig>,
	{ state = {} as Partial<Service>, options = {} as any } = {},
) {
	const svc = await Service.fromComposeObject(
		{
			appId,
			appUuid,
			serviceName,
			commit,
			// db ids should not be used for target state calculation, but images
			// are compared using _.isEqual so leaving this here to have image comparisons
			// match
			serviceId: 1,
			imageId: 1,
			releaseId: 1,
			...conf,
		},
		options,
	);

	// Add additonal configuration
	for (const k of Object.keys(state)) {
		(svc as any)[k] = (state as any)[k];
	}
	return svc;
}

export function createImage(
	{
		appId = 1,
		appUuid = 'appuuid',
		name = 'test-image',
		serviceName = 'main',
		commit = 'main-commit',
		...extra
	} = {} as Partial<Image>,
) {
	return {
		appId,
		appUuid,
		name,
		serviceName,
		commit,
		// db ids should not be used for target state calculation, but images
		// are compared using _.isEqual so leaving this here to have image comparisons
		// match
		imageId: 1,
		releaseId: 1,
		serviceId: 1,
		...extra,
	} as Image;
}

export function createApp({
	services = [] as Service[],
	networks = [] as Network[],
	volumes = [] as Volume[],
	isTarget = false,
	appId = 1,
	appUuid = 'appuuid',
} = {}) {
	return new App(
		{
			appId,
			appUuid,
			services,
			networks,
			volumes,
		},
		isTarget,
	);
}

export function createApps(
	{
		services = [] as Service[],
		networks = [] as Network[],
		volumes = [] as Volume[],
	},
	target = false,
) {
	const servicesByAppId = services.reduce(
		(svcs, s) => ({ ...svcs, [s.appId]: [s].concat(svcs[s.appId] || []) }),
		{} as Dictionary<Service[]>,
	);
	const volumesByAppId = volumes.reduce(
		(vols, v) => ({ ...vols, [v.appId]: [v].concat(vols[v.appId] || []) }),
		{} as Dictionary<Volume[]>,
	);
	const networksByAppId = networks.reduce(
		(nets, n) => ({ ...nets, [n.appId]: [n].concat(nets[n.appId] || []) }),
		{} as Dictionary<Network[]>,
	);

	const allAppIds = [
		...new Set([
			...Object.keys(servicesByAppId),
			...Object.keys(networksByAppId),
			...Object.keys(volumesByAppId),
		]),
	].map((i) => parseInt(i, 10));

	const apps: InstancedAppState = {};
	for (const appId of allAppIds) {
		apps[appId] = createApp({
			services: servicesByAppId[appId] ?? [],
			networks: networksByAppId[appId] ?? [],
			volumes: volumesByAppId[appId] ?? [],
			appId,
			appUuid: servicesByAppId[appId]?.[0]?.appUuid ?? 'deadbeef',
			isTarget: target,
		});
	}

	return apps;
}

export function createCurrentState({
	services = [] as Service[],
	networks = [] as Network[],
	volumes = [] as Volume[],
	images = services.map((s) => ({
		// Infer images from services by default
		dockerImageId: s.dockerImageId,
		...imageManager.imageFromService(s),
	})) as Image[],
	downloading = [] as string[],
}) {
	const currentApps = createApps({ services, networks, volumes });

	const containerIdsByAppId = services.reduce(
		(ids, s) => ({
			...ids,
			[s.appId]: {
				...ids[s.appId],
				...(s.serviceName &&
					s.containerId && { [s.serviceName]: s.containerId }),
			},
		}),
		{} as { [appId: number]: Dictionary<string> },
	);

	return {
		currentApps,
		availableImages: images,
		downloading,
		containerIdsByAppId,
	};
}

export const expectSteps = (
	action: CompositionStepAction,
	steps: CompositionStep[],
	min = 1,
	max = min,
	message = `Expected to find ${min} step(s) with action '${action}', instead found ${JSON.stringify(
		steps.map((s) => s.action),
	)}`,
) => {
	const filtered = steps.filter((s) => s.action === action);

	if (filtered.length < min || filtered.length > max) {
		throw new Error(message);
	}
	return filtered;
};

export function expectNoStep(
	action: CompositionStepAction,
	steps: CompositionStep[],
) {
	expectSteps(action, steps, 0, 0);
}
