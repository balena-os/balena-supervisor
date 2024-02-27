import _ from 'lodash';

import * as config from '../config';
import type { Image } from './images';
import * as images from './images';
import type Network from './network';
import type Service from './service';
import * as serviceManager from './service-manager';
import * as networkManager from './network-manager';
import * as volumeManager from './volume-manager';
import type Volume from './volume';
import * as commitStore from './commit';
import * as updateLock from '../lib/update-lock';
import type { DeviceLegacyReport } from '../types/state';

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
		};
	} & BaseCompositionStepArgs;
	remove: {
		current: Service;
	} & BaseCompositionStepArgs;
	updateMetadata: {
		current: Service;
		target: Service;
	};
	restart: {
		current: Service;
		target: Service;
		options?: {
			skipLock?: boolean;
		};
	} & BaseCompositionStepArgs;
	start: {
		target: Service;
	} & BaseCompositionStepArgs;
	updateCommit: {
		target: string;
		appId: number;
	};
	handover: {
		current: Service;
		target: Service;
		options?: {
			skipLock?: boolean;
			timeout?: number;
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
	cleanup: object;
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
	ensureSupervisorNetwork: object;
	noop: object;
	takeLock: {
		appId: number;
		services: string[];
	};
	releaseLock: {
		appId: number;
	};
}

export type CompositionStepAction = keyof CompositionStepArgs;
export type CompositionStepT<T extends CompositionStepAction> = {
	action: T;
} & CompositionStepArgs[T];
export type CompositionStep = CompositionStepT<CompositionStepAction>;

export function generateStep<T extends CompositionStepAction>(
	action: T,
	args: CompositionStepArgs[T],
): CompositionStep {
	return {
		action,
		...args,
	};
}

type Executors<T extends CompositionStepAction> = {
	[key in T]: (step: CompositionStepT<key>) => Promise<unknown>;
};
type LockingFn = (
	// TODO: Once the entire codebase is typescript, change
	// this to number
	app: number | number[] | null,
	args: BaseCompositionStepArgs,
	fn: () => Promise<unknown>,
) => Promise<unknown>;

interface CompositionCallbacks {
	// TODO: Once the entire codebase is typescript, change
	// this to number
	fetchStart: () => void;
	fetchEnd: () => void;
	fetchTime: (time: number) => void;
	stateReport: (state: DeviceLegacyReport) => void;
	bestDeltaSource: (image: Image, available: Image[]) => string | null;
}

export function getExecutors(app: {
	lockFn: LockingFn;
	callbacks: CompositionCallbacks;
}) {
	const executors: Executors<CompositionStepAction> = {
		stop: (step) => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					const wait = _.get(step, ['options', 'wait'], false);
					await serviceManager.kill(step.current, {
						removeContainer: false,
						wait,
					});
				},
			);
		},
		kill: (step) => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					await serviceManager.kill(step.current);
				},
			);
		},
		remove: async (step) => {
			// Only called for dead containers, so no need to
			// take locks
			await serviceManager.remove(step.current);
		},
		updateMetadata: async (step) => {
			// Should always be preceded by a takeLock step,
			// so the call is executed assuming that the lock is taken.
			await serviceManager.updateMetadata(step.current, step.target);
		},
		restart: (step) => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					await serviceManager.kill(step.current, { wait: true });
					await serviceManager.start(step.target);
				},
			);
		},
		start: async (step) => {
			await serviceManager.start(step.target);
		},
		updateCommit: async (step) => {
			await commitStore.upsertCommitForApp(step.appId, step.target);
		},
		handover: (step) => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					await serviceManager.handover(step.current, step.target);
				},
			);
		},
		fetch: async (step) => {
			const startTime = process.hrtime();
			app.callbacks.fetchStart();
			const [fetchOpts, availableImages] = await Promise.all([
				config.get('fetchOptions'),
				images.getAvailable(),
			]);

			const opts = {
				deltaSource: app.callbacks.bestDeltaSource(step.image, availableImages),
				...fetchOpts,
			};

			await images.triggerFetch(
				step.image,
				opts,
				async (success) => {
					app.callbacks.fetchEnd();
					const elapsed = process.hrtime(startTime);
					const elapsedMs = elapsed[0] * 1000 + elapsed[1] / 1e6;
					app.callbacks.fetchTime(elapsedMs);
					if (success) {
						// update_downloaded is true if *any* image has
						// been downloaded ,and it's relevant mostly for
						// the legacy GET /v1/device endpoint that assumes
						// a single container app
						app.callbacks.stateReport({ update_downloaded: true });
					}
				},
				step.serviceName,
			);
		},
		removeImage: async (step) => {
			await images.remove(step.image);
		},
		saveImage: async (step) => {
			await images.save(step.image);
		},
		cleanup: async () => {
			await images.cleanup();
		},
		createNetwork: async (step) => {
			await networkManager.create(step.target);
		},
		createVolume: async (step) => {
			await volumeManager.create(step.target);
		},
		removeNetwork: async (step) => {
			await networkManager.remove(step.current);
		},
		removeVolume: async (step) => {
			await volumeManager.remove(step.current);
		},
		ensureSupervisorNetwork: async () => {
			await networkManager.ensureSupervisorNetwork();
		},
		noop: async () => {
			/* async noop */
		},
		takeLock: async (step) => {
			await updateLock.takeLock(step.appId, step.services);
		},
		releaseLock: async (step) => {
			await updateLock.releaseLock(step.appId);
		},
	};

	return executors;
}
