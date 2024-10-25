import * as config from '../config';
import type { CompositionStepArgs, Image, CompositionStep } from './types';
import * as images from './images';
import * as serviceManager from './service-manager';
import * as networkManager from './network-manager';
import * as volumeManager from './volume-manager';
import * as commitStore from './commit';
import { Lockable, cleanLocksForApp } from '../lib/update-lock';
import { setRebootBreadcrumb } from '../lib/reboot';
import type { DeviceLegacyReport } from '../types/state';
import type { CompositionStepAction, CompositionStepT } from './types';
import type { Lock } from '../lib/update-lock';

export type {
	CompositionStep,
	CompositionStepT,
	CompositionStepAction,
} from './types';

type Executors<T extends CompositionStepAction> = {
	[key in T]: (step: CompositionStepT<key>) => Promise<unknown>;
};

interface CompositionCallbacks {
	// TODO: Once the entire codebase is typescript, change
	// this to number
	fetchStart: () => void;
	fetchEnd: () => void;
	fetchTime: (time: number) => void;
	stateReport: (state: DeviceLegacyReport) => void;
	bestDeltaSource: (image: Image, available: Image[]) => string | null;
	registerLock: (appId: string | number, lock: Lock) => void;
	unregisterLock: (appId: string | number) => void;
}

export function generateStep<T extends CompositionStepAction>(
	action: T,
	args: CompositionStepArgs[T],
): CompositionStep {
	return {
		action,
		...args,
	};
}

export function getExecutors(app: { callbacks: CompositionCallbacks }) {
	const executors: Executors<CompositionStepAction> = {
		stop: async (step) => {
			// Should always be preceded by a takeLock step,
			// so the call is executed assuming that the lock is taken.
			await serviceManager.kill(step.current, {
				removeContainer: false,
				wait: step.options?.wait || false,
			});
		},
		kill: async (step) => {
			// Should always be preceded by a takeLock step,
			// so the call is executed assuming that the lock is taken.
			await serviceManager.kill(step.current);
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
		restart: async (step) => {
			// Should always be preceded by a takeLock step,
			// so the call is executed assuming that the lock is taken.
			await serviceManager.kill(step.current, { wait: true });
			await serviceManager.start(step.target);
		},
		start: async (step) => {
			await serviceManager.start(step.target);
		},
		updateCommit: async (step) => {
			await commitStore.upsertCommitForApp(step.appId, step.target);
		},
		handover: async (step) => {
			// Should always be preceded by a takeLock step,
			// so the call is executed assuming that the lock is taken.
			await serviceManager.handover(step.current, step.target);
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
			const lockable = Lockable.from(step.appId, step.services);
			const lockOverride = await config.get('lockOverride');
			const lock = await lockable.lock({ force: step.force || lockOverride });
			app.callbacks.registerLock(step.appId, lock);
		},
		releaseLock: async (step) => {
			app.callbacks.unregisterLock(step.appId);
			if (step.lock != null) {
				await step.lock.unlock();
			}
			// Clean up any remaining locks
			await cleanLocksForApp(step.appId);
		},
		requireReboot: async (step) => {
			await setRebootBreadcrumb({ serviceName: step.serviceName });
		},
	};

	return executors;
}
