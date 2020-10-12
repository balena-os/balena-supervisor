import * as _ from 'lodash';

import * as config from '../config';

import * as applicationManager from './application-manager';
import type { Image } from './images';
import * as images from './images';
import Network from './network';
import Service from './service';
import * as serviceManager from './service-manager';
import Volume from './volume';

import { checkTruthy } from '../lib/validation';
import * as networkManager from './network-manager';
import * as volumeManager from './volume-manager';
import { DeviceReportFields } from '../types/state';
import { Span } from 'opentracing';
import tracer from '../tracing/tracer';

interface BaseCompositionStepArgs {
	force?: boolean;
	skipLock?: boolean;
}

interface TracerArgs {
	parentSpan?: Span;
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
	} & BaseCompositionStepArgs &
		TracerArgs;
	kill: {
		current: Service;
		options?: {
			skipLock?: boolean;
			wait?: boolean;
		};
	} & BaseCompositionStepArgs &
		TracerArgs;
	remove: {
		current: Service;
	} & BaseCompositionStepArgs &
		TracerArgs;
	updateMetadata: {
		current: Service;
		target: Service;
		options?: {
			skipLock?: boolean;
		};
	} & BaseCompositionStepArgs &
		TracerArgs;
	restart: {
		current: Service;
		target: Service;
		options?: {
			skipLock?: boolean;
		};
	} & BaseCompositionStepArgs &
		TracerArgs;
	stopAll: BaseCompositionStepArgs & TracerArgs;
	start: {
		target: Service;
	} & BaseCompositionStepArgs &
		TracerArgs;
	updateCommit: {
		target: string;
	} & BaseCompositionStepArgs &
		TracerArgs;
	handover: {
		current: Service;
		target: Service;
		options?: {
			skipLock?: boolean;
			timeout?: number;
		};
	} & BaseCompositionStepArgs &
		TracerArgs;
	fetch: {
		image: Image;
		serviceName: string;
	} & TracerArgs;
	removeImage: {
		image: Image;
	} & TracerArgs;
	saveImage: {
		image: Image;
	} & TracerArgs;
	cleanup: {} & TracerArgs;
	createNetwork: {
		target: Network;
	} & TracerArgs;
	createVolume: {
		target: Volume;
	} & TracerArgs;
	removeNetwork: {
		current: Network;
	} & TracerArgs;
	removeVolume: {
		current: Volume;
	} & TracerArgs;
	ensureSupervisorNetwork: {} & TracerArgs;
	noop: {};
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
	stateReport: (state: DeviceReportFields) => void;
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
					const span = tracer.startSpan('executors.stop', {
						childOf: step.parentSpan,
					});
					try {
						const wait = _.get(step, ['options', 'wait'], false);
						await serviceManager.kill(step.current, {
							removeContainer: false,
							wait,
						}, span);
						app.callbacks.containerKilled(step.current.containerId);
					} finally {
						span.finish();
					}
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
					const span = tracer.startSpan('executors.kill', {
						childOf: step.parentSpan,
					});
					try {
						await serviceManager.kill(step.current, {}, span);
						app.callbacks.containerKilled(step.current.containerId);
					} finally {
						span.finish();
					}
				},
			);
		},
		remove: async (step) => {
			// Only called for dead containers, so no need to
			// take locks
			const span = tracer.startSpan('executors.remove', {
				childOf: step.parentSpan,
			});
			try {
				await serviceManager.remove(step.current);
			} finally {
				span.finish();
			}
		},
		updateMetadata: (step) => {
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
					const span = tracer.startSpan('executors.updateMetadata', {
						childOf: step.parentSpan,
					});
					try {
						await serviceManager.updateMetadata(step.current, step.target);
					} finally {
						span.finish();
					}
				},
			);
		},
		restart: (step) => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					const span = tracer.startSpan('executors.restart', {
						childOf: step.parentSpan,
					});
					try {
						await serviceManager.kill(step.current, { wait: true }, span);
						app.callbacks.containerKilled(step.current.containerId);
						const container = await serviceManager.start(step.target);
						app.callbacks.containerStarted(container.id);
					} finally {
						span.finish();
					}
				},
			);
		},
		stopAll: async (step) => {
			const span = tracer.startSpan('executors.stopAll', {
				childOf: step.parentSpan,
			});
			try {
				await applicationManager.stopAll({
					force: step.force,
					skipLock: step.skipLock,
				});
			} finally {
				span.finish();
			}
		},
		start: async (step) => {
			const span = tracer.startSpan('executors.start', {
				childOf: step.parentSpan,
			});
			try {
				const container = await serviceManager.start(step.target, step.parentSpan);
				app.callbacks.containerStarted(container.id);
			} finally {
				span.finish();
			}
		},
		updateCommit: async (step) => {
			const span = tracer.startSpan('executors.updateCommit', {
				childOf: step.parentSpan,
			});
			try {
				await config.set({ currentCommit: step.target });
			} finally {
				span.finish();
			}
		},
		handover: (step) => {
			return app.lockFn(
				step.current.appId,
				{
					force: step.force,
					skipLock: step.skipLock || _.get(step, ['options', 'skipLock']),
				},
				async () => {
					const span = tracer.startSpan('executors.handover', {
						childOf: step.parentSpan,
					});
					try {
						await serviceManager.handover(step.current, step.target, step.parentSpan);
					} finally {
						span.finish();
					}
				},
			);
		},
		fetch: async (step) => {
			const span = tracer.startSpan('executors.fetch', {
				childOf: step.parentSpan,
			});
			try {
				const startTime = process.hrtime();
				app.callbacks.fetchStart();
				const [fetchOpts, availableImages] = await Promise.all([
					config.get('fetchOptions'),
					images.getAvailable(),
				]);

				const opts = {
					deltaSource: app.callbacks.bestDeltaSource(
						step.image,
						availableImages,
					),
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
			} finally {
				span.finish();
			}
		},
		removeImage: async (step) => {
			const span = tracer.startSpan('executors.removeImage', {
				childOf: step.parentSpan,
			});
			try {
				await images.remove(step.image);
			} finally {
				span.finish();
			}
		},
		saveImage: async (step) => {
			const span = tracer.startSpan('executors.saveImage', {
				childOf: step.parentSpan,
			});
			try {
				await images.save(step.image);
			} finally {
				span.finish();
			}
		},
		cleanup: async (step) => {
			const span = tracer.startSpan('executors.cleanup', {
				childOf: step.parentSpan,
			});
			try {
				const localMode = await config.get('localMode');
				if (!localMode) {
					await images.cleanup();
				}
			} finally {
				span.finish();
			}
		},
		createNetwork: async (step) => {
			const span = tracer.startSpan('executors.createNetwork', {
				childOf: step.parentSpan,
			});
			try {
				await networkManager.create(step.target);
			} finally {
				span.finish();
			}
		},
		createVolume: async (step) => {
			const span = tracer.startSpan('executors.createVolume', {
				childOf: step.parentSpan,
			});
			try {
				await volumeManager.create(step.target);
			} finally {
				span.finish();
			}
		},
		removeNetwork: async (step) => {
			const span = tracer.startSpan('executors.removeNetwork', {
				childOf: step.parentSpan,
			});
			try {
				await networkManager.remove(step.current);
			} finally {
				span.finish();
			}
		},
		removeVolume: async (step) => {
			const span = tracer.startSpan('executors.removeVolume', {
				childOf: step.parentSpan,
			});
			try {
				await volumeManager.remove(step.current);
			} finally {
				span.finish();
			}
		},
		ensureSupervisorNetwork: async (step) => {
			const span = tracer.startSpan('executors.ensureSupervisorNetwork', {
				childOf: step.parentSpan,
			});
			try {
				networkManager.ensureSupervisorNetwork();
			} finally {
				span.finish();
			}
		},
		noop: async () => {
			/* async noop */
		},
	};

	return executors;
}
