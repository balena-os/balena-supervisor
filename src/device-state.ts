import Bluebird from 'bluebird';
import { stripIndent } from 'common-tags';
import { EventEmitter } from 'events';
import _ from 'lodash';
import type StrictEventEmitter from 'strict-event-emitter-types';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';
import prettyMs from 'pretty-ms';

import * as config from './config';
import * as db from './db';
import * as logger from './logger';

import * as globalEventBus from './event-bus';
import * as network from './network';
import * as deviceConfig from './device-config';

import * as constants from './lib/constants';
import * as dbus from './lib/dbus';
import {
	InternalInconsistencyError,
	TargetStateError,
	UpdatesLockedError,
} from './lib/errors';
import * as updateLock from './lib/update-lock';
import { takeGlobalLockRO, takeGlobalLockRW } from './lib/process-lock';
import * as dbFormat from './device-state/db-format';
import { getGlobalApiKey } from './device-api';
import * as sysInfo from './lib/system-info';
import { log } from './lib/supervisor-console';
import { loadTargetFromFile } from './device-state/preload';
import * as applicationManager from './compose/application-manager';
import * as commitStore from './compose/commit';

import type {
	DeviceLegacyState,
	InstancedDeviceState,
	DeviceState,
	DeviceReport,
	AppState,
} from './types';
import { TargetState } from './types';
import type {
	CompositionStepT,
	CompositionStepAction,
} from './compose/composition-steps';
import * as fsUtils from './lib/fs-utils';
import { pathOnRoot } from './lib/host-utils';
import { setTimeout } from 'timers/promises';

const TARGET_STATE_CONFIG_DUMP = pathOnRoot(
	'/tmp/balena-supervisor/target-state-config',
);

function parseTargetState(state: unknown): TargetState {
	const res = TargetState.decode(state);

	if (isRight(res)) {
		return res.right;
	}

	const errors = ['Invalid target state.'].concat(Reporter.report(res));
	throw new TargetStateError(errors.join('\n'));
}

interface DeviceStateEvents {
	error: Error;
	change: void;
	shutdown: void;
	'apply-target-state-end': Nullable<Error>;
	'apply-target-state-error': Error;

	'step-error': (
		err: Nullable<Error>,
		step: DeviceStateStep<PossibleStepTargets>,
	) => void;

	'step-completed': (
		err: Nullable<Error>,
		step: DeviceStateStep<PossibleStepTargets>,
		result?: { Data: string; Error: Nullable<Error> },
	) => void;
}
type DeviceStateEventEmitter = StrictEventEmitter<
	EventEmitter,
	DeviceStateEvents
>;
const events = new EventEmitter() as DeviceStateEventEmitter;
export const on: (typeof events)['on'] = events.on.bind(events);
export const once: (typeof events)['once'] = events.once.bind(events);
export const removeListener: (typeof events)['removeListener'] =
	events.removeListener.bind(events);
export const removeAllListeners: (typeof events)['removeAllListeners'] =
	events.removeAllListeners.bind(events);

export type DeviceStateStepTarget = 'reboot' | 'shutdown' | 'noop';

type PossibleStepTargets = CompositionStepAction | DeviceStateStepTarget;
type DeviceStateStep<T extends PossibleStepTargets> =
	| { action: DeviceStateStepTarget }
	| CompositionStepT<T extends CompositionStepAction ? T : never>
	| deviceConfig.ConfigStep;

let currentVolatile: DeviceReport = {};
let maxPollTime: number;
let intermediateTarget: InstancedDeviceState | null = null;
let applyBlocker: Nullable<Promise<void>>;
let cancelDelay: null | (() => void) = null;

let failedUpdates: number = 0;
let applyCancelled = false;
let lastApplyStart = process.hrtime();
let scheduledApply: { force?: boolean; delay?: number } | null = null;
let shuttingDown = false;

let applyInProgress = false;
export let connected: boolean;
export let lastSuccessfulUpdate: number | null = null;

events.on('error', (err) => log.error('deviceState error: ', err));
events.on('apply-target-state-end', function (err) {
	if (err != null) {
		if (!(err instanceof UpdatesLockedError)) {
			return log.error('Device state apply error', err);
		}
	} else {
		log.success('Device state apply success');
		// We also let the device-config module know that we
		// successfully reached the target state and that it
		// should clear any rate limiting it's applied
		return deviceConfig.resetRateLimits();
	}
});

export const initialized = _.once(async () => {
	await config.initialized();
	await applicationManager.initialized();

	applicationManager.on('change', (d) => reportCurrentState(d));

	config.on('change', (changedConfig) => {
		if (changedConfig.loggingEnabled != null) {
			logger.enable(changedConfig.loggingEnabled);
		}

		if (changedConfig.appUpdatePollInterval != null) {
			maxPollTime = changedConfig.appUpdatePollInterval;
		}
	});
});

export function isApplyInProgress() {
	return applyInProgress;
}

export async function healthcheck() {
	const unmanaged = await config.get('unmanaged');

	// Don't have to perform checks for unmanaged
	if (unmanaged) {
		return true;
	}

	const cycleTime = process.hrtime(lastApplyStart);
	const cycleTimeMs = cycleTime[0] * 1000 + cycleTime[1] / 1e6;
	const cycleTimeWithinInterval =
		cycleTimeMs - applicationManager.timeSpentFetching < 2 * maxPollTime;

	// Check if target is healthy
	const applyTargetHealthy =
		!applyInProgress ||
		applicationManager.fetchesInProgress > 0 ||
		cycleTimeWithinInterval;

	if (!applyTargetHealthy) {
		log.info(
			stripIndent`
				Healthcheck failure - At least ONE of the following conditions must be true:
					- No applyInProgress      ? ${!(applyInProgress === true)}
					- fetchesInProgress       ? ${applicationManager.fetchesInProgress > 0}
					- cycleTimeWithinInterval ? ${cycleTimeWithinInterval}`,
		);
	}

	// All tests pass!
	return applyTargetHealthy;
}

export async function initNetworkChecks({
	apiEndpoint,
	connectivityCheckEnabled,
}: {
	apiEndpoint: config.ConfigType<'apiEndpoint'>;
	connectivityCheckEnabled: config.ConfigType<'connectivityCheckEnabled'>;
}) {
	await network.startConnectivityCheck(
		apiEndpoint,
		connectivityCheckEnabled,
		(c) => {
			connected = c;
		},
	);
	config.on('change', function (changedConfig) {
		if (changedConfig.connectivityCheckEnabled != null) {
			network.enableConnectivityCheck(changedConfig.connectivityCheckEnabled);
		}
	});
	log.debug('Starting periodic check for IP addresses');

	network.startIPAddressUpdate()(async (addresses) => {
		const macAddress = await config.get('macAddress');
		reportCurrentState({
			ip_address: addresses.join(' '),
			mac_address: macAddress,
		});
	}, constants.ipAddressUpdateInterval);
}

async function saveInitialConfig() {
	const devConf = await deviceConfig.getCurrent();

	await deviceConfig.setTarget(devConf);
	await config.set({ initialConfigSaved: true });
}

export async function loadInitialState() {
	await applicationManager.initialized();

	const conf = await config.getMany([
		'initialConfigSaved',
		'listenPort',
		'osVersion',
		'osVariant',
		'macAddress',
		'version',
		'provisioned',
		'apiEndpoint',
		'connectivityCheckEnabled',
		'legacyAppsPresent',
		'targetStateSet',
		'unmanaged',
		'appUpdatePollInterval',
	]);
	maxPollTime = conf.appUpdatePollInterval;

	await initNetworkChecks(conf);

	if (!conf.initialConfigSaved) {
		await saveInitialConfig();
	}

	log.info('Reporting initial state, supervisor version and API info');
	const globalApiKey = await getGlobalApiKey();
	reportCurrentState({
		api_port: conf.listenPort,
		api_secret: globalApiKey,
		os_version: conf.osVersion,
		os_variant: conf.osVariant,
		mac_address: conf.macAddress,
		supervisor_version: conf.version,
		provisioning_progress: null,
		provisioning_state: '',
		status: 'Idle',
		logs_channel: null,
		update_failed: false,
		update_pending: false,
		update_downloaded: false,
	});

	let loadedFromFile = false;
	if (!conf.provisioned || !conf.targetStateSet) {
		loadedFromFile = await loadTargetFromFile(constants.appsJsonPath);
	} else {
		log.debug('Skipping preloading');
	}

	// Only apply target if we have received a target
	// from the cloud or loaded from file
	if (conf.targetStateSet || loadedFromFile) {
		triggerApplyTarget({ initial: true });
	}
}

// We keep compatibility with the StrictEventEmitter types
// from the outside, but within this function all hells
// breaks loose due to the liberal any casting
function emitAsync<T extends keyof DeviceStateEvents>(
	ev: T,
	...args: DeviceStateEvents[T] extends (...args: infer TArgs) => void
		? TArgs
		: Array<DeviceStateEvents[T]>
) {
	return setImmediate(() => events.emit(ev as any, ...args));
}

const readLockTarget = () =>
	takeGlobalLockRO('target').disposer((release) => release());
const writeLockTarget = () =>
	takeGlobalLockRW('target').disposer((release) => release());
const inferStepsLock = () =>
	takeGlobalLockRW('inferSteps').disposer((release) => release());
function usingReadLockTarget<T extends () => any, U extends ReturnType<T>>(
	fn: T,
): Bluebird<UnwrappedPromise<U>> {
	return Bluebird.using(readLockTarget, () => fn());
}
function usingWriteLockTarget<T extends () => any, U extends ReturnType<T>>(
	fn: T,
): Bluebird<UnwrappedPromise<U>> {
	return Bluebird.using(writeLockTarget, () => fn());
}
function usingInferStepsLock<T extends () => any, U extends ReturnType<T>>(
	fn: T,
): Bluebird<UnwrappedPromise<U>> {
	return Bluebird.using(inferStepsLock, () => fn());
}

export async function setTarget(target: TargetState, localSource?: boolean) {
	await db.initialized();
	await config.initialized();

	// When we get a new target state, clear any built up apply errors
	// This means that we can attempt to apply the new state instantly
	if (localSource == null) {
		localSource = false;
	}
	failedUpdates = 0;

	// This will throw if target state is invalid
	target = parseTargetState(target);

	globalEventBus.getInstance().emit('targetStateChanged', target);

	const { uuid, apiEndpoint } = await config.getMany(['uuid', 'apiEndpoint']);

	if (!uuid || !target[uuid]) {
		throw new Error(
			`Expected target state for local device with uuid '${uuid}'.`,
		);
	}

	const localTarget = target[uuid];

	await fsUtils.writeAndSyncFile(
		TARGET_STATE_CONFIG_DUMP,
		JSON.stringify(localTarget.config),
	);

	await usingWriteLockTarget(async () => {
		await db.transaction(async (trx) => {
			await config.set({ name: localTarget.name }, trx);
			await deviceConfig.setTarget(localTarget.config, trx);

			if (localSource || apiEndpoint == null || apiEndpoint === '') {
				await applicationManager.setTarget(localTarget.apps, 'local', trx);
			} else {
				await applicationManager.setTarget(localTarget.apps, apiEndpoint, trx);
			}
			await config.set({ targetStateSet: true }, trx);
		});
	});
}

export function getTarget({
	initial = false,
	intermediate = false,
}: {
	initial?: boolean;
	intermediate?: boolean;
} = {}): Bluebird<InstancedDeviceState> {
	return usingReadLockTarget(async () => {
		if (intermediate) {
			return intermediateTarget!;
		}

		return {
			local: {
				name: await config.get('name'),
				config: await deviceConfig.getTarget({ initial }),
				apps: await dbFormat.getApps(),
			},
		};
	});
}

// This returns the current state of the device in (more or less)
// the same format as the target state. This method,
// getCurrent and getCurrentForComparison should probably get
// merged into a single method
// @deprecated
export async function getLegacyState(): Promise<DeviceLegacyState> {
	const appsStatus = await applicationManager.getLegacyState();
	const theState: DeepPartial<DeviceLegacyState> = {
		local: {},
	};
	theState.local = {
		...theState.local,
		...currentVolatile,
	};
	theState.local!.apps = appsStatus.local;

	// Multi-app warning!
	// If we have more than one app, simply return the first commit.
	// Fortunately this won't become a problem until we have system apps, and then
	// at that point we can filter non-system apps leaving a single user app.
	// After this, for true multi-app, we will need to report our status back in a
	// different way, meaning this function will no longer be needed
	const appIds = Object.keys(theState.local!.apps).map((strId) =>
		parseInt(strId, 10),
	);

	const appId: number | undefined = appIds[0];
	if (appId != null) {
		const commit = await commitStore.getCommitForApp(appId);

		if (commit != null && !applyInProgress) {
			theState.local!.is_on__commit = commit;
		}
	}

	return theState as DeviceLegacyState;
}

async function getSysInfo(
	lastInfo: Partial<sysInfo.SystemInfo>,
): Promise<sysInfo.SystemInfo> {
	// If hardwareMetrics is false, send null patch for system metrics to cloud API
	const currentInfo = {
		...((await config.get('hardwareMetrics'))
			? await sysInfo.getSystemMetrics()
			: {
					cpu_usage: null,
					memory_usage: null,
					memory_total: null,
					storage_usage: null,
					storage_total: null,
					storage_block_device: null,
					cpu_temp: null,
					cpu_id: null,
				}),
		...(await sysInfo.getSystemChecks()),
	};

	return Object.assign(
		{} as sysInfo.SystemInfo,
		...Object.keys(currentInfo).map((key: keyof sysInfo.SystemInfo) => ({
			[key]: sysInfo.isSignificantChange(
				key,
				lastInfo[key] as number,
				currentInfo[key] as number,
			)
				? (currentInfo[key] as number)
				: (lastInfo[key] as number),
		})),
	);
}

/** SysInfo (metrics) property names used in report. */
export const sysInfoPropertyNames = [
	'cpu_usage',
	'memory_usage',
	'memory_total',
	'storage_usage',
	'storage_total',
	'storage_block_device',
	'cpu_temp',
	'cpu_id',
];

// Return current state in a way that the API understands
export async function getCurrentForReport(
	lastReport = {} as DeviceState,
): Promise<DeviceState> {
	const apps = await applicationManager.getState();

	// Fiter current apps by the target state as the supervisor cannot
	// report on apps for which it doesn't have API permissions
	const targetAppUuids = Object.keys(await applicationManager.getTargetApps());
	const appsForReport = Object.keys(apps)
		.filter((appUuid) => targetAppUuids.includes(appUuid))
		.reduce(
			(filteredApps, appUuid) => ({
				...filteredApps,
				[appUuid]: apps[appUuid],
			}),
			{} as { [appUuid: string]: AppState },
		);

	const { uuid, localMode } = await config.getMany(['uuid', 'localMode']);

	if (!uuid) {
		throw new InternalInconsistencyError('No uuid found for local device');
	}

	const omitFromReport = [
		'update_pending',
		'update_downloaded',
		'update_failed',
		...(localMode ? ['apps', 'logs_channel'] : []),
	];

	const systemInfo = await getSysInfo(lastReport[uuid] ?? {});

	return {
		[uuid]: _.omitBy(
			{
				...currentVolatile,
				...systemInfo,
				apps: appsForReport,
			},
			(__, key) => omitFromReport.includes(key),
		),
	};
}

// Get the current state as object instances
export async function getCurrentState(): Promise<InstancedDeviceState> {
	const [name, devConfig, apps] = await Promise.all([
		config.get('name'),
		deviceConfig.getCurrent(),
		applicationManager.getCurrentApps(),
	]);

	return {
		local: {
			name,
			config: devConfig,
			apps,
		},
	};
}

export function reportCurrentState(newState: DeviceReport = {}) {
	if (newState == null) {
		newState = {};
	}
	currentVolatile = { ...currentVolatile, ...newState };
	emitAsync('change', undefined);
}

export interface ShutdownOpts {
	force?: boolean;
	reboot?: boolean;
}

export async function shutdown({
	force = false,
	reboot = false,
}: ShutdownOpts = {}) {
	await updateLock.abortIfHUPInProgress({ force });
	// Get current apps to create locks for
	const apps = await applicationManager.getCurrentApps();
	const appIds = Object.keys(apps).map((strId) => parseInt(strId, 10));
	// Try to create a lock for all the services before shutting down
	return updateLock.lock(appIds, { force }, async () => {
		let dbusAction;
		switch (reboot) {
			case true:
				logger.logSystemMessage('Rebooting', {}, 'Reboot');
				dbusAction = await dbus.reboot();
				break;
			case false:
				logger.logSystemMessage('Shutting down', {}, 'Shutdown');
				dbusAction = await dbus.shutdown();
				break;
		}
		shuttingDown = true;
		emitAsync('shutdown', undefined);
		return dbusAction;
	});
}

// FIXME: this method should not be exported, all target state changes
// should happen via intermediate targets
export async function executeStepAction(
	step: DeviceStateStep<PossibleStepTargets>,
	{ force, initial }: { force?: boolean; initial?: boolean },
) {
	if (deviceConfig.isValidAction(step.action)) {
		await deviceConfig.executeStepAction(step as deviceConfig.ConfigStep, {
			initial,
		});
	} else if (applicationManager.validActions.includes(step.action)) {
		return applicationManager.executeStep(step as any, {
			force,
		});
	} else {
		switch (step.action) {
			case 'reboot':
				// There isn't really a way that these methods can fail,
				// and if they do, we wouldn't know about it until after
				// the response has been sent back to the API.
				await shutdown({ force, reboot: true });
				return;
			case 'shutdown':
				await shutdown({ force, reboot: false });
				return;
			case 'noop':
				return;
			default:
				throw new Error(`Invalid action ${step.action}`);
		}
	}
}

export async function applyStep(
	step: DeviceStateStep<PossibleStepTargets>,
	{
		force,
		initial,
	}: {
		force?: boolean;
		initial?: boolean;
	},
) {
	if (shuttingDown) {
		return;
	}
	try {
		await executeStepAction(step, {
			force,
			initial,
		});
		emitAsync('step-completed', null, step);
	} catch (e: any) {
		emitAsync('step-error', e, step);
		throw e;
	}
}

function applyError(
	err: Error,
	{
		force,
		initial,
		intermediate,
	}: { force?: boolean; initial?: boolean; intermediate?: boolean },
) {
	emitAsync('apply-target-state-error', err);
	emitAsync('apply-target-state-end', err);
	if (intermediate) {
		throw err;
	}
	failedUpdates += 1;
	reportCurrentState({ update_failed: true });
	if (scheduledApply != null) {
		if (!(err instanceof UpdatesLockedError)) {
			log.error(
				"Updating failed, but there's another update scheduled immediately: ",
				err,
			);
		}
	} else {
		const delay = Math.min(
			Math.pow(2, failedUpdates) * constants.backoffIncrement,
			maxPollTime,
		);
		// If there was an error then schedule another attempt briefly in the future.
		if (err instanceof UpdatesLockedError) {
			const message = `Updates are locked, retrying in ${prettyMs(delay, {
				compact: true,
			})}. Reason: ${err.message}`;
			logger.logSystemMessage(message, {}, 'updateLocked', false);
			log.info(message);
		} else {
			log.error(
				`Scheduling another update attempt in ${delay}ms due to failure: `,
				err,
			);
		}
		return triggerApplyTarget({ force, delay, initial });
	}
}

// We define this function this way so we can mock it in the tests
export const applyTarget = async ({
	force = false,
	initial = false,
	intermediate = false,
	nextDelay = 200,
	retryCount = 0,
	keepVolumes = undefined as boolean | undefined,
} = {}) => {
	if (!intermediate) {
		await applyBlocker;
	}
	await applicationManager.localModeSwitchCompletion();

	return usingInferStepsLock(async () => {
		const [currentState, targetState] = await Promise.all([
			getCurrentState(),
			getTarget({ initial, intermediate }),
		]);
		const deviceConfigSteps = await deviceConfig.getRequiredSteps(
			currentState,
			targetState,
		);
		const noConfigSteps = _.every(
			deviceConfigSteps,
			({ action }) => action === 'noop',
		);

		let backoff: boolean;
		let steps: Array<DeviceStateStep<PossibleStepTargets>>;

		if (!noConfigSteps) {
			backoff = false;
			steps = deviceConfigSteps;
		} else {
			const appSteps = await applicationManager.getRequiredSteps(
				currentState.local.apps,
				targetState.local.apps,
				// Do not remove images while applying an intermediate state
				// if not applying intermediate, we let getRequired steps set
				// the value
				intermediate || undefined,
				keepVolumes,
				force,
			);

			if (_.isEmpty(appSteps)) {
				// If we retrieve a bunch of no-ops from the
				// device config, generally we want to back off
				// more than if we retrieve them from the
				// application manager
				backoff = true;
				steps = deviceConfigSteps;
			} else {
				backoff = false;
				steps = appSteps;
			}
		}

		if (_.isEmpty(steps)) {
			emitAsync('apply-target-state-end', null);
			if (!intermediate) {
				log.debug('Finished applying target state');
				applicationManager.resetTimeSpentFetching();
				failedUpdates = 0;
				lastSuccessfulUpdate = Date.now();
				reportCurrentState({
					update_failed: false,
					update_pending: false,
					update_downloaded: false,
				});
			}
			return;
		}

		if (!intermediate) {
			reportCurrentState({ update_pending: true });
		}
		if (_.every(steps, (step) => step.action === 'noop')) {
			if (backoff) {
				retryCount += 1;
				// Backoff to a maximum of 10 minutes
				nextDelay = Math.min(Math.pow(2, retryCount) * 1000, 60 * 10 * 1000);
			} else {
				nextDelay = 1000;
			}
		}

		try {
			await Promise.all(steps.map((s) => applyStep(s, { force, initial })));

			await setTimeout(nextDelay);
			await applyTarget({
				force,
				initial,
				intermediate,
				nextDelay,
				retryCount,
				keepVolumes,
			});
		} catch (e: any) {
			if (e instanceof UpdatesLockedError) {
				// Forward the UpdatesLockedError directly
				throw e;
			}
			throw new Error(
				'Failed to apply state transition steps. ' +
					e.message +
					' Steps:' +
					JSON.stringify(_.map(steps, 'action')),
			);
		}
	}).catch((err) => {
		return applyError(err, { force, initial, intermediate });
	});
};

function pausingApply(fn: () => any) {
	const lock = () => {
		return takeGlobalLockRW('pause').disposer((release) => release());
	};
	// TODO: This function is a bit of a mess
	const pause = () => {
		return Bluebird.try(() => {
			let res;
			applyBlocker = new Promise((resolve) => {
				res = resolve;
			});
			return res;
		}).disposer((resolve: any) => resolve());
	};

	return Bluebird.using(lock(), () => Bluebird.using(pause(), () => fn()));
}

export function triggerApplyTarget({
	force = false,
	delay = 0,
	initial = false,
	isFromApi = false,
} = {}) {
	if (applyInProgress) {
		if (scheduledApply == null || (isFromApi && cancelDelay)) {
			scheduledApply = { force, delay };
			if (isFromApi) {
				// Cancel promise delay if call came from api to
				// prevent waiting due to backoff (and if we've
				// previously setup a delay)
				cancelDelay?.();
			}
		} else {
			// If a delay has been set it's because we need to hold off before applying again,
			// so we need to respect the maximum delay that has
			// been passed
			if (scheduledApply.delay === undefined || isNaN(scheduledApply.delay)) {
				log.debug(
					`Tried to apply target with invalid delay: ${scheduledApply.delay}`,
				);
				throw new InternalInconsistencyError(
					'No delay specified in scheduledApply',
				);
			}
			scheduledApply.delay = Math.max(delay, scheduledApply.delay);
			if (!scheduledApply.force) {
				scheduledApply.force = force;
			}
		}
		return;
	}
	applyCancelled = false;
	applyInProgress = true;
	void new Promise((resolve, reject) => {
		void setTimeout(delay).then(resolve);
		cancelDelay = reject;
	})
		.catch(() => {
			applyCancelled = true;
		})
		.then(() => {
			cancelDelay = null;
			if (applyCancelled) {
				log.info('Skipping applyTarget because of a cancellation');
				return;
			}
			lastApplyStart = process.hrtime();
			log.info('Applying target state');
			return applyTarget({ force, initial });
		})
		.finally(() => {
			applyInProgress = false;
			reportCurrentState();
			if (scheduledApply != null) {
				triggerApplyTarget(scheduledApply);
				scheduledApply = null;
			}
		});
	return null;
}

export async function applyIntermediateTarget(
	intermediate: InstancedDeviceState,
	{ force = false, keepVolumes = undefined as boolean | undefined } = {},
) {
	return pausingApply(async () => {
		// TODO: Make sure we don't accidentally overwrite this
		intermediateTarget = intermediate;
		applyInProgress = true;
		return applyTarget({
			intermediate: true,
			force,
			keepVolumes,
		}).then(() => {
			intermediateTarget = null;
			applyInProgress = false;
		});
	});
}
