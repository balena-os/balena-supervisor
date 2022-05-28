import * as Bluebird from 'bluebird';
import { stripIndent } from 'common-tags';
import { EventEmitter } from 'events';
import * as express from 'express';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import prettyMs = require('pretty-ms');

import * as config from './config';
import * as db from './db';
import * as logger from './logger';

import {
	CompositionStepT,
	CompositionStepAction,
} from './compose/composition-steps';
import { loadTargetFromFile } from './device-state/preload';
import * as globalEventBus from './event-bus';
import * as hostConfig from './host-config';
import constants = require('./lib/constants');
import * as dbus from './lib/dbus';
import {
	InternalInconsistencyError,
	TargetStateError,
	UpdatesLockedError,
} from './lib/errors';
import * as updateLock from './lib/update-lock';
import * as validation from './lib/validation';
import * as network from './network';

import * as applicationManager from './compose/application-manager';
import * as commitStore from './compose/commit';
import * as deviceConfig from './device-config';
import { ConfigStep } from './device-config';
import { log } from './lib/supervisor-console';
import {
	DeviceLegacyState,
	InstancedDeviceState,
	TargetState,
	DeviceState,
	DeviceReport,
	AppState,
} from './types';
import * as dbFormat from './device-state/db-format';
import * as apiKeys from './lib/api-keys';
import * as sysInfo from './lib/system-info';

const disallowedHostConfigPatchFields = ['local_ip', 'local_port'];

function parseTargetState(state: unknown): TargetState {
	const res = TargetState.decode(state);

	if (isRight(res)) {
		return res.right;
	}

	const errors = ['Invalid target state.'].concat(Reporter.report(res));
	throw new TargetStateError(errors.join('\n'));
}

// TODO (refactor): This shouldn't be here, and instead should be part of the other
// device api stuff in ./device-api
function createDeviceStateRouter() {
	router = express.Router();

	const rebootOrShutdown = async (
		req: express.Request,
		res: express.Response,
		action: DeviceStateStepTarget,
	) => {
		const override = await config.get('lockOverride');
		const force = validation.checkTruthy(req.body.force) || override;
		try {
			const response = await executeStepAction({ action }, { force });
			res.status(202).json(response);
		} catch (e) {
			const status = e instanceof UpdatesLockedError ? 423 : 500;
			res.status(status).json({
				Data: '',
				Error: (e != null ? e.message : undefined) || e || 'Unknown error',
			});
		}
	};
	router.post('/v1/reboot', (req, res) => rebootOrShutdown(req, res, 'reboot'));
	router.post('/v1/shutdown', (req, res) =>
		rebootOrShutdown(req, res, 'shutdown'),
	);

	router.get('/v1/device/host-config', (_req, res) =>
		hostConfig
			.get()
			.then((conf) => res.json(conf))
			.catch((err) =>
				res.status(503).send(err?.message ?? err ?? 'Unknown error'),
			),
	);

	router.patch('/v1/device/host-config', async (req, res) => {
		// Because v1 endpoints are legacy, and this endpoint might already be used
		// by multiple users, adding too many throws might have unintended side effects.
		// Thus we're simply logging invalid fields and allowing the request to continue.

		try {
			if (!req.body.network) {
				log.warn("Key 'network' must exist in PATCH body");
				// If network does not exist, skip all field validation checks below
				throw new Error();
			}

			const { proxy } = req.body.network;

			// Validate proxy fields, if they exist
			if (proxy && Object.keys(proxy).length) {
				const blacklistedFields = Object.keys(proxy).filter((key) =>
					disallowedHostConfigPatchFields.includes(key),
				);

				if (blacklistedFields.length > 0) {
					log.warn(`Invalid proxy field(s): ${blacklistedFields.join(', ')}`);
				}

				if (
					proxy.type &&
					!constants.validRedsocksProxyTypes.includes(proxy.type)
				) {
					log.warn(
						`Invalid redsocks proxy type, must be one of ${constants.validRedsocksProxyTypes.join(
							', ',
						)}`,
					);
				}

				if (proxy.noProxy && !Array.isArray(proxy.noProxy)) {
					log.warn('noProxy field must be an array of addresses');
				}
			}
		} catch (e) {
			/* noop */
		}

		try {
			// If hostname is an empty string, return first 7 digits of device uuid
			if (req.body.network?.hostname === '') {
				const uuid = await config.get('uuid');
				req.body.network.hostname = uuid?.slice(0, 7);
			}
			const lockOverride = await config.get('lockOverride');
			await hostConfig.patch(
				req.body,
				validation.checkTruthy(req.body.force) || lockOverride,
			);
			res.status(200).send('OK');
		} catch (err) {
			// TODO: We should be able to throw err if it's UpdatesLockedError
			// and the error middleware will handle it, but this doesn't work in
			// the test environment. Fix this when fixing API tests.
			if (err instanceof UpdatesLockedError) {
				return res.status(423).send(err?.message ?? err);
			}
			res.status(503).send(err?.message ?? err ?? 'Unknown error');
		}
	});

	router.get('/v1/device', async (_req, res) => {
		try {
			const state = await getLegacyState();
			const stateToSend = _.pick(state.local, [
				'api_port',
				'ip_address',
				'os_version',
				'mac_address',
				'supervisor_version',
				'update_pending',
				'update_failed',
				'update_downloaded',
			]) as Dictionary<unknown>;
			if (state.local?.is_on__commit != null) {
				stateToSend.commit = state.local.is_on__commit;
			}
			const service = _.toPairs(
				_.toPairs(state.local?.apps)[0]?.[1]?.services,
			)[0]?.[1];

			if (service != null) {
				stateToSend.status = service.status;
				if (stateToSend.status === 'Running') {
					stateToSend.status = 'Idle';
				}
				stateToSend.download_progress = service.download_progress;
			}
			res.json(stateToSend);
		} catch (e) {
			res.status(500).json({
				Data: '',
				Error: (e != null ? e.message : undefined) || e || 'Unknown error',
			});
		}
	});

	router.use(applicationManager.router);
	return router;
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
export const on: typeof events['on'] = events.on.bind(events);
export const once: typeof events['once'] = events.once.bind(events);
export const removeListener: typeof events['removeListener'] = events.removeListener.bind(
	events,
);
export const removeAllListeners: typeof events['removeAllListeners'] = events.removeAllListeners.bind(
	events,
);

type DeviceStateStepTarget = 'reboot' | 'shutdown' | 'noop';

type PossibleStepTargets = CompositionStepAction | DeviceStateStepTarget;
type DeviceStateStep<T extends PossibleStepTargets> =
	| {
			action: 'reboot';
	  }
	| { action: 'shutdown' }
	| { action: 'noop' }
	| CompositionStepT<T extends CompositionStepAction ? T : never>
	| ConfigStep;

let currentVolatile: DeviceReport = {};
const writeLock = updateLock.writeLock;
const readLock = updateLock.readLock;
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

export let router: express.Router;

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

export const initialized = (async () => {
	await config.initialized;
	await applicationManager.initialized;

	applicationManager.on('change', (d) => reportCurrentState(d));
	createDeviceStateRouter();

	config.on('change', (changedConfig) => {
		if (changedConfig.loggingEnabled != null) {
			logger.enable(changedConfig.loggingEnabled);
		}

		if (changedConfig.appUpdatePollInterval != null) {
			maxPollTime = changedConfig.appUpdatePollInterval;
		}
	});
})();

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
	network.startConnectivityCheck(apiEndpoint, connectivityCheckEnabled, (c) => {
		connected = c;
	});
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
	await applicationManager.initialized;
	await apiKeys.initialized;

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

	initNetworkChecks(conf);

	if (!conf.initialConfigSaved) {
		await saveInitialConfig();
	}

	log.info('Reporting initial state, supervisor version and API info');
	reportCurrentState({
		api_port: conf.listenPort,
		api_secret: apiKeys.cloudApiKey,
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
	readLock('target').disposer((release) => release());
const writeLockTarget = () =>
	writeLock('target').disposer((release) => release());
const inferStepsLock = () =>
	writeLock('inferSteps').disposer((release) => release());
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
	await db.initialized;
	await config.initialized;

	// When we get a new target state, clear any built up apply errors
	// This means that we can attempt to apply the new state instantly
	if (localSource == null) {
		localSource = false;
	}
	failedUpdates = 0;

	// This will throw if target state is invalid
	target = parseTargetState(target);

	globalEventBus.getInstance().emit('targetStateChanged', target);

	const { uuid, apiEndpoint } = await config.getMany([
		'uuid',
		'apiEndpoint',
		'name',
	]);

	if (!uuid || !target[uuid]) {
		throw new Error(
			`Expected target state for local device with uuid '${uuid}'.`,
		);
	}

	const localTarget = target[uuid];

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
}: { initial?: boolean; intermediate?: boolean } = {}): Bluebird<
	InstancedDeviceState
> {
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
			dependent: await applicationManager.getDependentTargets(),
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
		dependent: {},
	};
	theState.local = {
		...theState.local,
		...currentVolatile,
	};
	theState.local!.apps = appsStatus.local;
	theState.dependent!.apps = appsStatus.dependent;

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

	const { name, uuid, localMode } = await config.getMany([
		'name',
		'uuid',
		'localMode',
	]);

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
				name,
				apps: appsForReport,
			},
			(__, key) => omitFromReport.includes(key),
		),
	};
}

// Get the current state as object instances
export async function getCurrentState(): Promise<InstancedDeviceState> {
	const [name, devConfig, apps, dependent] = await Promise.all([
		config.get('name'),
		deviceConfig.getCurrent(),
		applicationManager.getCurrentApps(),
		applicationManager.getDependentState(),
	]);

	return {
		local: {
			name,
			config: devConfig,
			apps,
		},
		dependent,
	};
}

export function reportCurrentState(newState: DeviceReport = {}) {
	if (newState == null) {
		newState = {};
	}
	currentVolatile = { ...currentVolatile, ...newState };
	emitAsync('change', undefined);
}

export async function reboot(force?: boolean, skipLock?: boolean) {
	await updateLock.abortIfHUPInProgress({ force });
	await applicationManager.stopAll({ force, skipLock });
	logger.logSystemMessage('Rebooting', {}, 'Reboot');
	const $reboot = await dbus.reboot();
	shuttingDown = true;
	emitAsync('shutdown', undefined);
	return await $reboot;
}

export async function shutdown(force?: boolean, skipLock?: boolean) {
	await updateLock.abortIfHUPInProgress({ force });
	await applicationManager.stopAll({ force, skipLock });
	logger.logSystemMessage('Shutting down', {}, 'Shutdown');
	const $shutdown = await dbus.shutdown();
	shuttingDown = true;
	emitAsync('shutdown', undefined);
	return $shutdown;
}

export async function executeStepAction<T extends PossibleStepTargets>(
	step: DeviceStateStep<T>,
	{
		force,
		initial,
		skipLock,
	}: { force?: boolean; initial?: boolean; skipLock?: boolean },
) {
	if (deviceConfig.isValidAction(step.action)) {
		await deviceConfig.executeStepAction(step as ConfigStep, {
			initial,
		});
	} else if (_.includes(applicationManager.validActions, step.action)) {
		return applicationManager.executeStep(step as any, {
			force,
			skipLock,
		});
	} else {
		switch (step.action) {
			case 'reboot':
				// There isn't really a way that these methods can fail,
				// and if they do, we wouldn't know about it until after
				// the response has been sent back to the API. Just return
				// "OK" for this and the below action
				await reboot(force, skipLock);
				return {
					Data: 'OK',
					Error: null,
				};
			case 'shutdown':
				await shutdown(force, skipLock);
				return {
					Data: 'OK',
					Error: null,
				};
			case 'noop':
				return;
			default:
				throw new Error(`Invalid action ${step.action}`);
		}
	}
}

export async function applyStep<T extends PossibleStepTargets>(
	step: DeviceStateStep<T>,
	{
		force,
		initial,
		skipLock,
	}: {
		force?: boolean;
		initial?: boolean;
		skipLock?: boolean;
	},
) {
	if (shuttingDown) {
		return;
	}
	try {
		const stepResult = await executeStepAction(step, {
			force,
			initial,
			skipLock,
		});
		emitAsync('step-completed', null, step, stepResult || undefined);
	} catch (e) {
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
	skipLock = false,
	nextDelay = 200,
	retryCount = 0,
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
			await Promise.all(
				steps.map((s) => applyStep(s, { force, initial, skipLock })),
			);

			await Bluebird.delay(nextDelay);
			await applyTarget({
				force,
				initial,
				intermediate,
				skipLock,
				nextDelay,
				retryCount,
			});
		} catch (e) {
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

export function pausingApply(fn: () => any) {
	const lock = () => {
		return writeLock('pause').disposer((release) => release());
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
	new Bluebird((resolve, reject) => {
		setTimeout(resolve, delay);
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

export function applyIntermediateTarget(
	intermediate: InstancedDeviceState,
	{ force = false, skipLock = false } = {},
) {
	// TODO: Make sure we don't accidentally overwrite this
	intermediateTarget = intermediate;
	return applyTarget({ intermediate: true, force, skipLock }).then(() => {
		intermediateTarget = null;
	});
}
