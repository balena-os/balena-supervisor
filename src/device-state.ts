import * as Bluebird from 'bluebird';
import * as bodyParser from 'body-parser';
import { EventEmitter } from 'events';
import * as express from 'express';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';

import prettyMs = require('pretty-ms');

import Config, { ConfigType } from './config';
import Database from './db';
import EventTracker from './event-tracker';
import Logger from './logger';

import {
	CompositionStep,
	CompositionStepAction,
} from './compose/composition-steps';
import { loadTargetFromFile } from './device-state/preload';
import * as hostConfig from './host-config';
import constants = require('./lib/constants');
import { InternalInconsistencyError, UpdatesLockedError } from './lib/errors';
import * as systemd from './lib/systemd';
import * as updateLock from './lib/update-lock';
import * as validation from './lib/validation';
import * as network from './network';

import ApplicationManager = require('./application-manager');
import DeviceConfig, { ConfigStep } from './device-config';
import { log } from './lib/supervisor-console';
import {
	DeviceReportFields,
	DeviceStatus,
	InstancedDeviceState,
	TargetState,
} from './types/state';

function validateLocalState(state: any): asserts state is TargetState['local'] {
	if (state.name != null) {
		if (!validation.isValidShortText(state.name)) {
			throw new Error('Invalid device name');
		}
	}
	if (state.apps == null || !validation.isValidAppsObject(state.apps)) {
		throw new Error('Invalid apps');
	}
	if (state.config == null || !validation.isValidEnv(state.config)) {
		throw new Error('Invalid device configuration');
	}
}

function validateDependentState(
	state: any,
): asserts state is TargetState['dependent'] {
	if (
		state.apps != null &&
		!validation.isValidDependentAppsObject(state.apps)
	) {
		throw new Error('Invalid dependent apps');
	}
	if (
		state.devices != null &&
		!validation.isValidDependentDevicesObject(state.devices)
	) {
		throw new Error('Invalid dependent devices');
	}
}

function validateState(state: any): asserts state is TargetState {
	if (!_.isObject(state)) {
		throw new Error('State must be an object');
	}
	if (!_.isObject(state.local)) {
		throw new Error('Local state must be an object');
	}
	validateLocalState(state.local);
	if (state.dependent != null) {
		return validateDependentState(state.dependent);
	}
}

// TODO (refactor): This shouldn't be here, and instead should be part of the other
// device api stuff in ./device-api
function createDeviceStateRouter(deviceState: DeviceState) {
	const router = express.Router();
	router.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
	router.use(bodyParser.json({ limit: '10mb' }));

	const rebootOrShutdown = async (
		req: express.Request,
		res: express.Response,
		action: DeviceStateStepTarget,
	) => {
		const override = await deviceState.config.get('lockOverride');
		const force = validation.checkTruthy(req.body.force) || override;
		try {
			const response = await deviceState.executeStepAction(
				{ action },
				{ force },
			);
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
			.then(conf => res.json(conf))
			.catch(err =>
				res.status(503).send(err?.message ?? err ?? 'Unknown error'),
			),
	);

	router.patch('/v1/device/host-config', (req, res) =>
		hostConfig
			.patch(req.body, deviceState.config)
			.then(() => res.status(200).send('OK'))
			.catch(err =>
				res.status(503).send(err?.message ?? err ?? 'Unknown error'),
			),
	);

	router.get('/v1/device', async (_req, res) => {
		try {
			const state = await deviceState.getStatus();
			const stateToSend = _.pick(state.local, [
				'api_port',
				'ip_address',
				'os_version',
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

	router.use(deviceState.applications.router);
	return router;
}

interface DeviceStateConstructOpts {
	db: Database;
	config: Config;
	eventTracker: EventTracker;
	logger: Logger;
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

type DeviceStateStepTarget = 'reboot' | 'shutdown' | 'noop';

type PossibleStepTargets = CompositionStepAction | DeviceStateStepTarget;
type DeviceStateStep<T extends PossibleStepTargets> =
	| {
			action: 'reboot';
	  }
	| { action: 'shutdown' }
	| { action: 'noop' }
	| CompositionStep<T extends CompositionStepAction ? T : never>
	| ConfigStep;

export class DeviceState extends (EventEmitter as new () => DeviceStateEventEmitter) {
	public db: Database;
	public config: Config;
	public eventTracker: EventTracker;
	public logger: Logger;

	public applications: ApplicationManager;
	public deviceConfig: DeviceConfig;

	private currentVolatile: DeviceReportFields = {};
	private writeLock = updateLock.writeLock;
	private readLock = updateLock.readLock;
	private cancelDelay: null | (() => void) = null;
	private maxPollTime: number;
	private intermediateTarget: TargetState | null = null;
	private applyBlocker: Nullable<Promise<void>>;

	public lastSuccessfulUpdate: number | null = null;
	public failedUpdates: number = 0;
	public applyInProgress = false;
	public applyCancelled = false;
	public lastApplyStart = process.hrtime();
	public scheduledApply: { force?: boolean; delay?: number } | null = null;
	public shuttingDown = false;
	public connected: boolean;
	public router: express.Router;

	constructor({ db, config, eventTracker, logger }: DeviceStateConstructOpts) {
		super();
		this.db = db;
		this.config = config;
		this.eventTracker = eventTracker;
		this.logger = logger;
		this.deviceConfig = new DeviceConfig({
			db: this.db,
			config: this.config,
			logger: this.logger,
		});
		this.applications = new ApplicationManager({
			config: this.config,
			logger: this.logger,
			db: this.db,
			eventTracker: this.eventTracker,
			deviceState: this,
		});

		this.on('error', err => log.error('deviceState error: ', err));
		this.on('apply-target-state-end', function(err) {
			if (err != null) {
				if (!(err instanceof UpdatesLockedError)) {
					return log.error('Device state apply error', err);
				}
			} else {
				log.success('Device state apply success');
				// We also let the device-config module know that we
				// successfully reached the target state and that it
				// should clear any rate limiting it's applied
				return this.deviceConfig.resetRateLimits();
			}
		});
		this.applications.on('change', d => this.reportCurrentState(d));
		this.router = createDeviceStateRouter(this);
	}

	public async healthcheck() {
		const unmanaged = await this.config.get('unmanaged');
		const cycleTime = process.hrtime(this.lastApplyStart);
		const cycleTimeMs = cycleTime[0] * 1000 + cycleTime[1] / 1e6;

		const cycleTimeWithinInterval =
			cycleTimeMs - this.applications.timeSpentFetching < 2 * this.maxPollTime;

		const applyTargetHealthy =
			unmanaged ||
			!this.applyInProgress ||
			this.applications.fetchesInProgress > 0 ||
			cycleTimeWithinInterval;

		return applyTargetHealthy;
	}

	public async init() {
		this.config.on('change', changedConfig => {
			if (changedConfig.loggingEnabled != null) {
				this.logger.enable(changedConfig.loggingEnabled);
			}
			if (changedConfig.apiSecret != null) {
				this.reportCurrentState({ api_secret: changedConfig.apiSecret });
			}
			if (changedConfig.appUpdatePollInterval != null) {
				this.maxPollTime = changedConfig.appUpdatePollInterval;
			}
		});

		const conf = await this.config.getMany([
			'initialConfigSaved',
			'listenPort',
			'apiSecret',
			'osVersion',
			'osVariant',
			'version',
			'provisioned',
			'apiEndpoint',
			'connectivityCheckEnabled',
			'legacyAppsPresent',
			'targetStateSet',
			'unmanaged',
			'appUpdatePollInterval',
		]);
		this.maxPollTime = conf.appUpdatePollInterval;

		await this.applications.init();
		if (!conf.initialConfigSaved) {
			return this.saveInitialConfig();
		}

		this.initNetworkChecks(conf);

		log.info('Reporting initial state, supervisor version and API info');
		await this.reportCurrentState({
			api_port: conf.listenPort,
			api_secret: conf.apiSecret,
			os_version: conf.osVersion,
			os_variant: conf.osVariant,
			supervisor_version: conf.version,
			provisioning_progress: null,
			provisioning_state: '',
			status: 'Idle',
			logs_channel: null,
			update_failed: false,
			update_pending: false,
			update_downloaded: false,
		});

		const targetApps = await this.applications.getTargetApps();
		if (!conf.provisioned || (_.isEmpty(targetApps) && !conf.targetStateSet)) {
			try {
				await loadTargetFromFile(null, this);
			} finally {
				await this.config.set({ targetStateSet: true });
			}
		} else {
			log.debug('Skipping preloading');
			if (conf.provisioned && !_.isEmpty(targetApps)) {
				// If we're in this case, it's because we've updated from an older supervisor
				// and we need to mark that the target state has been set so that
				// the supervisor doesn't try to preload again if in the future target
				// apps are empty again (which may happen with multi-app).
				await this.config.set({ targetStateSet: true });
			}
		}
		await this.triggerApplyTarget({ initial: true });
	}

	public async initNetworkChecks({
		apiEndpoint,
		connectivityCheckEnabled,
	}: {
		apiEndpoint: ConfigType<'apiEndpoint'>;
		connectivityCheckEnabled: ConfigType<'connectivityCheckEnabled'>;
	}) {
		network.startConnectivityCheck(
			apiEndpoint,
			connectivityCheckEnabled,
			connected => {
				return (this.connected = connected);
			},
		);
		this.config.on('change', function(changedConfig) {
			if (changedConfig.connectivityCheckEnabled != null) {
				return network.enableConnectivityCheck(
					changedConfig.connectivityCheckEnabled,
				);
			}
		});
		log.debug('Starting periodic check for IP addresses');

		await network.startIPAddressUpdate()(async addresses => {
			await this.reportCurrentState({
				ip_address: addresses.join(' '),
			});
		}, constants.ipAddressUpdateInterval);
	}

	private async saveInitialConfig() {
		const devConf = await this.deviceConfig.getCurrent();

		await this.deviceConfig.setTarget(devConf);
		await this.config.set({ initialConfigSaved: true });
	}

	// We keep compatibility with the StrictEventEmitter types
	// from the outside, but within this function all hells
	// breaks loose due to the liberal any casting
	private emitAsync<T extends keyof DeviceStateEvents>(
		ev: T,
		...args: DeviceStateEvents[T] extends (...args: any) => void
			? Parameters<DeviceStateEvents[T]>
			: Array<DeviceStateEvents[T]>
	) {
		if (_.isArray(args)) {
			return setImmediate(() => this.emit(ev as any, ...args));
		} else {
			return setImmediate(() => this.emit(ev as any, args));
		}
	}

	private readLockTarget = () =>
		this.readLock('target').disposer(release => release());
	private writeLockTarget = () =>
		this.writeLock('target').disposer(release => release());
	private inferStepsLock = () =>
		this.writeLock('inferSteps').disposer(release => release());
	private usingReadLockTarget(fn: () => any) {
		return Bluebird.using(this.readLockTarget, () => fn());
	}
	private usingWriteLockTarget(fn: () => any) {
		return Bluebird.using(this.writeLockTarget, () => fn());
	}
	private usingInferStepsLock(fn: () => any) {
		return Bluebird.using(this.inferStepsLock, () => fn());
	}

	public async setTarget(target: TargetState, localSource?: boolean) {
		// When we get a new target state, clear any built up apply errors
		// This means that we can attempt to apply the new state instantly
		if (localSource == null) {
			localSource = false;
		}
		this.failedUpdates = 0;

		validateState(target);
		const apiEndpoint = await this.config.get('apiEndpoint');

		await this.usingWriteLockTarget(async () => {
			await this.db.transaction(async trx => {
				await this.config.set({ name: target.local.name }, trx);
				await this.deviceConfig.setTarget(target.local.config, trx);

				if (localSource || apiEndpoint == null) {
					await this.applications.setTarget(
						target.local.apps,
						target.dependent,
						'local',
						trx,
					);
				} else {
					await this.applications.setTarget(
						target.local.apps,
						target.dependent,
						apiEndpoint,
						trx,
					);
				}
			});
		});
	}

	public getTarget({
		initial = false,
		intermediate = false,
	}: { initial?: boolean; intermediate?: boolean } = {}): Bluebird<
		InstancedDeviceState
	> {
		return this.usingReadLockTarget(async () => {
			if (intermediate) {
				return this.intermediateTarget;
			}

			return {
				local: {
					name: await this.config.get('name'),
					config: await this.deviceConfig.getTarget({ initial }),
					apps: await this.applications.getTargetApps(),
				},
				dependent: await this.applications.getDependentTargets(),
			};
		}) as Bluebird<InstancedDeviceState>;
	}

	public async getStatus(): Promise<DeviceStatus> {
		const appsStatus = await this.applications.getStatus();
		const theState: DeepPartial<DeviceStatus> = {
			local: {},
			dependent: {},
		};
		theState.local = { ...theState.local, ...this.currentVolatile };
		theState.local.apps = appsStatus.local;
		theState.dependent!.apps = appsStatus.dependent;
		if (appsStatus.commit && !this.applyInProgress) {
			theState.local.is_on__commit = appsStatus.commit;
		}

		return theState as DeviceStatus;
	}

	public async getCurrentForComparison(): Promise<
		DeviceStatus & { local: { name: string } }
	> {
		const [name, devConfig, apps, dependent] = await Promise.all([
			this.config.get('name'),
			this.deviceConfig.getCurrent(),
			this.applications.getCurrentForComparison(),
			this.applications.getDependentState(),
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

	public reportCurrentState(newState: DeviceReportFields = {}) {
		if (newState == null) {
			newState = {};
		}
		this.currentVolatile = { ...this.currentVolatile, ...newState };
		return this.emitAsync('change', undefined);
	}

	private async reboot(force?: boolean, skipLock?: boolean) {
		await this.applications.stopAll({ force, skipLock });
		this.logger.logSystemMessage('Rebooting', {}, 'Reboot');
		const reboot = await systemd.reboot();
		this.shuttingDown = true;
		this.emitAsync('shutdown', undefined);
		return reboot;
	}

	private async shutdown(force?: boolean, skipLock?: boolean) {
		await this.applications.stopAll({ force, skipLock });
		this.logger.logSystemMessage('Shutting down', {}, 'Shutdown');
		const shutdown = await systemd.shutdown();
		this.shuttingDown = true;
		this.emitAsync('shutdown', undefined);
		return shutdown;
	}

	public async executeStepAction<T extends PossibleStepTargets>(
		step: DeviceStateStep<T>,
		{
			force,
			initial,
			skipLock,
		}: { force?: boolean; initial?: boolean; skipLock?: boolean },
	) {
		if (this.deviceConfig.isValidAction(step.action)) {
			await this.deviceConfig.executeStepAction(step as ConfigStep, {
				initial,
			});
		} else if (_.includes(this.applications.validActions, step.action)) {
			return this.applications.executeStepAction(step as any, {
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
					await this.reboot(force, skipLock);
					return {
						Data: 'OK',
						Error: null,
					};
				case 'shutdown':
					await this.shutdown(force, skipLock);
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

	public async applyStep<T extends PossibleStepTargets>(
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
		if (this.shuttingDown) {
			return;
		}
		try {
			const stepResult = await this.executeStepAction(step, {
				force,
				initial,
				skipLock,
			});
			this.emitAsync('step-completed', null, step, stepResult || undefined);
		} catch (e) {
			this.emitAsync('step-error', e, step);
			throw e;
		}
	}

	private applyError(
		err: Error,
		{
			force,
			initial,
			intermediate,
		}: { force?: boolean; initial?: boolean; intermediate?: boolean },
	) {
		this.emitAsync('apply-target-state-error', err);
		this.emitAsync('apply-target-state-end', err);
		if (intermediate) {
			throw err;
		}
		this.failedUpdates += 1;
		this.reportCurrentState({ update_failed: true });
		if (this.scheduledApply != null) {
			if (!(err instanceof UpdatesLockedError)) {
				log.error(
					"Updating failed, but there's another update scheduled immediately: ",
					err,
				);
			}
		} else {
			const delay = Math.min(
				Math.pow(2, this.failedUpdates) * constants.backoffIncrement,
				this.maxPollTime,
			);
			// If there was an error then schedule another attempt briefly in the future.
			if (err instanceof UpdatesLockedError) {
				const message = `Updates are locked, retrying in ${prettyMs(delay, {
					compact: true,
				})}...`;
				this.logger.logSystemMessage(message, {}, 'updateLocked', false);
				log.info(message);
			} else {
				log.error(
					`Scheduling another update attempt in ${delay}ms due to failure: `,
					err,
				);
			}
			return this.triggerApplyTarget({ force, delay, initial });
		}
	}

	public async applyTarget({
		force = false,
		initial = false,
		intermediate = false,
		skipLock = false,
		nextDelay = 200,
		retryCount = 0,
	} = {}) {
		if (!intermediate) {
			await this.applyBlocker;
		}
		await this.applications.localModeSwitchCompletion();

		return this.usingInferStepsLock(async () => {
			const [currentState, targetState] = await Promise.all([
				this.getCurrentForComparison(),
				this.getTarget({ initial, intermediate }),
			]);
			const extraState = await this.applications.getExtraStateForComparison(
				currentState,
				targetState,
			);
			const deviceConfigSteps = await this.deviceConfig.getRequiredSteps(
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
				const appSteps = await this.applications.getRequiredSteps(
					currentState,
					targetState,
					extraState,
					intermediate,
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
				this.emitAsync('apply-target-state-end', null);
				if (!intermediate) {
					log.debug('Finished applying target state');
					this.applications.timeSpentFetching = 0;
					this.failedUpdates = 0;
					this.lastSuccessfulUpdate = Date.now();
					this.reportCurrentState({
						update_failed: false,
						update_pending: false,
						update_downloaded: false,
					});
				}
				return;
			}

			if (!intermediate) {
				this.reportCurrentState({ update_pending: true });
			}
			if (_.every(steps, step => step.action === 'noop')) {
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
					steps.map(s => this.applyStep(s, { force, initial, skipLock })),
				);

				await Bluebird.delay(nextDelay);
				await this.applyTarget({
					force,
					initial,
					intermediate,
					skipLock,
					nextDelay,
					retryCount,
				});
			} catch (e) {
				const detailedError = new Error(
					'Failed to apply state transition steps. ' +
						e.message +
						' Steps:' +
						JSON.stringify(_.map(steps, 'action')),
				);
				return this.applyError(detailedError, {
					force,
					initial,
					intermediate,
				});
			}
		}).catch(err => {
			return this.applyError(err, { force, initial, intermediate });
		});
	}

	public pausingApply(fn: () => any) {
		const lock = () => {
			return this.writeLock('pause').disposer(release => release());
		};
		// TODO: This function is a bit of a mess
		const pause = () => {
			return Bluebird.try(() => {
				let res = null;
				this.applyBlocker = new Promise(resolve => {
					res = resolve;
				});
				return res;
			}).disposer((resolve: any) => resolve());
		};

		return Bluebird.using(lock(), () => Bluebird.using(pause(), () => fn()));
	}

	public triggerApplyTarget({
		force = false,
		delay = 0,
		initial = false,
		isFromApi = false,
	} = {}) {
		if (this.applyInProgress) {
			if (this.scheduledApply == null || (isFromApi && this.cancelDelay)) {
				this.scheduledApply = { force, delay };
				if (isFromApi) {
					// Cancel promise delay if call came from api to
					// prevent waiting due to backoff (and if we've
					// previously setup a delay)
					this.cancelDelay?.();
				}
			} else {
				// If a delay has been set it's because we need to hold off before applying again,
				// so we need to respect the maximum delay that has
				// been passed
				if (!this.scheduledApply.delay) {
					throw new InternalInconsistencyError(
						'No delay specified in scheduledApply',
					);
				}
				this.scheduledApply.delay = Math.max(delay, this.scheduledApply.delay);
				if (!this.scheduledApply.force) {
					this.scheduledApply.force = force;
				}
			}
			return;
		}
		this.applyCancelled = false;
		this.applyInProgress = true;
		new Bluebird((resolve, reject) => {
			setTimeout(resolve, delay);
			this.cancelDelay = reject;
		})
			.catch(() => {
				this.applyCancelled = true;
			})
			.then(() => {
				this.cancelDelay = null;
				if (this.applyCancelled) {
					log.info('Skipping applyTarget because of a cancellation');
					return;
				}
				this.lastApplyStart = process.hrtime();
				log.info('Applying target state');
				return this.applyTarget({ force, initial });
			})
			.finally(() => {
				this.applyInProgress = false;
				this.reportCurrentState();
				if (this.scheduledApply != null) {
					this.triggerApplyTarget(this.scheduledApply);
					this.scheduledApply = null;
				}
			});
		return null;
	}

	public applyIntermediateTarget(
		intermediateTarget: TargetState,
		{ force = false, skipLock = false } = {},
	) {
		this.intermediateTarget = _.cloneDeep(intermediateTarget);
		return this.applyTarget({ intermediate: true, force, skipLock }).then(
			() => {
				this.intermediateTarget = null;
			},
		);
	}
}

export default DeviceState;
