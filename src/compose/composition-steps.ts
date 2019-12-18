import * as _ from 'lodash';

import Config from '../config';

import ApplicationManager = require('../application-manager');
import Images, { Image } from './images';
import Network from './network';
import Service from './service';
import ServiceManager from './service-manager';
import Volume from './volume';

import { checkTruthy } from '../lib/validation';
import { NetworkManager } from './network-manager';
import VolumeManager from './volume-manager';

interface BaseCompositionStepArgs {
	force?: boolean;
	skipLock?: boolean;
}

// FIXME: Most of the steps take the
// BaseCompositionStepArgs, but some also take an options
// structure which includes some of the same fields. It
// would be nice to remove the need for this
interface CompositionStepArgs {
	stop: {
		current: Service;
		options?: {
			skipLock?: boolean;
			wait?: boolean;
		};
	} & BaseCompositionStepArgs;
	kill: {
		current: Service;
		options?: {
			skipLock?: boolean;
			wait?: boolean;
			removeImage?: boolean;
		};
	} & BaseCompositionStepArgs;
	remove: {
		current: Service;
	} & BaseCompositionStepArgs;
	updateMetadata: {
		current: Service;
		target: { imageId: number; releaseId: number };
		options?: {
			skipLock?: boolean;
		};
	} & BaseCompositionStepArgs;
	restart: {
		current: Service;
		target: Service;
		options?: {
			skipLock?: boolean;
		};
	} & BaseCompositionStepArgs;
	stopAll: BaseCompositionStepArgs;
	start: {
		target: Service;
	} & BaseCompositionStepArgs;
	updateCommit: {
		target: string;
	};
	handover: {
		current: Service;
		target: Service;
		options?: {
			skipLock?: boolean;
		};
	} & BaseCompositionStepArgs;
	fetch: {
		image: Image;
		serviceName: string;
	};
	removeImage: {
		image: Image;
	};
	saveImage: {
		image: Image;
	};
	cleanup: {};
	createNetwork: {
		target: Network;
	};
	createVolume: {
		target: Volume;
	};
	removeNetwork: {
		current: Network;
	};
	removeVolume: {
		current: Volume;
	};
	ensureSupervisorNetwork: {};
}

export type CompositionStepAction = keyof CompositionStepArgs;
export type CompositionStep<T extends CompositionStepAction> = {
	action: T;
} & CompositionStepArgs[T];

export function generateStep<T extends CompositionStepAction>(
	action: T,
	args: CompositionStepArgs[T],
): CompositionStep<T> {
	return {
		action,
		...args,
	};
}

type Executors<T extends CompositionStepAction> = {
	[key in T]: (step: CompositionStep<key>) => Promise<unknown>;
};
type LockingFn = (
	// TODO: Once the entire codebase is typescript, change
	// this to number
	app: number | null,
	args: BaseCompositionStepArgs,
	fn: () => Promise<unknown>,
) => Promise<unknown>;

interface CompositionCallbacks {
	// TODO: Once the entire codebase is typescript, change
	// this to number
	containerStarted: (containerId: string | null) => void;
	containerKilled: (containerId: string | null) => void;
	fetchStart: () => void;
	fetchEnd: () => void;
	fetchTime: (time: number) => void;
	stateReport: (state: Dictionary<unknown>) => Promise<void>;
	bestDeltaSource: (image: Image, available: Image[]) => string | null;
}

export function getExecutors(app: {
	lockFn: LockingFn;
	services: ServiceManager;
	networks: NetworkManager;
	volumes: VolumeManager;
	applications: ApplicationManager;
	images: Images;
	config: Config;
	callbacks: CompositionCallbacks;
}) {
	const executors: Executors<CompositionStepAction> = {
		stop: step => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					const wait = _.get(step, ['options', 'wait'], false);
					await app.services.kill(step.current, {
						removeContainer: false,
						wait,
					});
					app.callbacks.containerKilled(step.current.containerId);
				},
			);
		},
		kill: step => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					await app.services.kill(step.current);
					app.callbacks.containerKilled(step.current.containerId);
					if (_.get(step, ['options', 'removeImage'])) {
						await app.images.removeByDockerId(step.current.config.image);
					}
				},
			);
		},
		remove: async step => {
			// Only called for dead containers, so no need to
			// take locks
			await app.services.remove(step.current);
		},
		updateMetadata: step => {
			const skipLock =
				step.skipLock ||
				checkTruthy(step.current.config.labels['io.balena.legacy-container']);
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					await app.services.updateMetadata(step.current, step.target);
				},
			);
		},
		restart: step => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					await app.services.kill(step.current, { wait: true });
					app.callbacks.containerKilled(step.current.containerId);
					const container = await app.services.start(step.target);
					app.callbacks.containerStarted(container.id);
				},
			);
		},
		stopAll: async step => {
			await app.applications.stopAll({
				force: step.force,
				skipLock: step.skipLock,
			});
		},
		start: async step => {
			const container = await app.services.start(step.target);
			app.callbacks.containerStarted(container.id);
		},
		updateCommit: async step => {
			await app.config.set({ currentCommit: step.target });
		},
		handover: step => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					await app.services.handover(step.current, step.target);
				},
			);
		},
		fetch: async step => {
			const startTime = process.hrtime();
			app.callbacks.fetchStart();
			const [fetchOpts, availableImages] = await Promise.all([
				app.config.get('fetchOptions'),
				app.images.getAvailable(),
			]);

			const opts = {
				deltaSource: app.callbacks.bestDeltaSource(step.image, availableImages),
				...fetchOpts,
			};

			await app.images.triggerFetch(
				step.image,
				opts,
				async success => {
					app.callbacks.fetchEnd();
					const elapsed = process.hrtime(startTime);
					const elapsedMs = elapsed[0] * 1000 + elapsed[1] / 1e6;
					app.callbacks.fetchTime(elapsedMs);
					if (success) {
						// update_downloaded is true if *any* image has
						// been downloaded ,and it's relevant mostly for
						// the legacy GET /v1/device endpoint that assumes
						// a single container app
						await app.callbacks.stateReport({ update_downloaded: true });
					}
				},
				step.serviceName,
			);
		},
		removeImage: async step => {
			await app.images.remove(step.image);
		},
		saveImage: async step => {
			await app.images.save(step.image);
		},
		cleanup: async () => {
			const localMode = await app.config.get('localMode');
			if (!localMode) {
				await app.images.cleanup();
			}
		},
		createNetwork: async step => {
			await app.networks.create(step.target);
		},
		createVolume: async step => {
			await app.volumes.create(step.target);
		},
		removeNetwork: async step => {
			await app.networks.remove(step.current);
		},
		removeVolume: async step => {
			await app.volumes.remove(step.current);
		},
		ensureSupervisorNetwork: async () => {
			app.networks.ensureSupervisorNetwork();
		},
	};

	return executors;
}
