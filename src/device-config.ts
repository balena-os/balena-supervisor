import * as _ from 'lodash';
import { inspect } from 'util';

import Config from './config';
import { SchemaTypeKey } from './config/schema-type';
import Database, { Transaction } from './db';
import Logger from './logger';

import { ConfigOptions, DeviceConfigBackend } from './config/backend';
import * as configUtils from './config/utils';
import { UnitNotLoadedError } from './lib/errors';
import * as systemd from './lib/systemd';
import { EnvVarObject } from './lib/types';
import { checkInt, checkTruthy } from './lib/validation';
import { DeviceStatus } from './types/state';

const vpnServiceName = 'openvpn-resin';

interface DeviceConfigConstructOpts {
	db: Database;
	config: Config;
	logger: Logger;
}

interface ConfigOption {
	envVarName: string;
	varType: string;
	defaultValue: string;
	rebootRequired?: boolean;
}

// FIXME: Bring this and the deviceState and
// applicationState steps together
export interface ConfigStep {
	// TODO: This is a bit of a mess, the DeviceConfig class shouldn't
	// know that the reboot action exists as it is implemented by
	// DeviceState. Fix this weird circular dependency
	action: keyof DeviceActionExecutors | 'reboot' | 'noop';
	humanReadableTarget?: Dictionary<string>;
	target?: string | Dictionary<string>;
	rebootRequired?: boolean;
}

interface DeviceActionExecutorOpts {
	initial?: boolean;
}

type DeviceActionExecutorFn = (
	step: ConfigStep,
	opts?: DeviceActionExecutorOpts,
) => Promise<void>;

interface DeviceActionExecutors {
	changeConfig: DeviceActionExecutorFn;
	setVPNEnabled: DeviceActionExecutorFn;
	setBootConfig: DeviceActionExecutorFn;
}

export class DeviceConfig {
	private db: Database;
	private config: Config;
	private logger: Logger;
	private rebootRequired = false;
	private actionExecutors: DeviceActionExecutors;
	private configBackend: DeviceConfigBackend | null = null;

	private static readonly configKeys: Dictionary<ConfigOption> = {
		appUpdatePollInterval: {
			envVarName: 'SUPERVISOR_POLL_INTERVAL',
			varType: 'int',
			defaultValue: '60000',
		},
		instantUpdates: {
			envVarName: 'SUPERVISOR_INSTANT_UPDATE_TRIGGER',
			varType: 'bool',
			defaultValue: 'true',
		},
		localMode: {
			envVarName: 'SUPERVISOR_LOCAL_MODE',
			varType: 'bool',
			defaultValue: 'false',
		},
		connectivityCheckEnabled: {
			envVarName: 'SUPERVISOR_CONNECTIVITY_CHECK',
			varType: 'bool',
			defaultValue: 'true',
		},
		loggingEnabled: {
			envVarName: 'SUPERVISOR_LOG_CONTROL',
			varType: 'bool',
			defaultValue: 'true',
		},
		delta: {
			envVarName: 'SUPERVISOR_DELTA',
			varType: 'bool',
			defaultValue: 'false',
		},
		deltaRequestTimeout: {
			envVarName: 'SUPERVISOR_DELTA_REQUEST_TIMEOUT',
			varType: 'int',
			defaultValue: '30000',
		},
		deltaApplyTimeout: {
			envVarName: 'SUPERVISOR_DELTA_APPLY_TIMEOUT',
			varType: 'int',
			defaultValue: '0',
		},
		deltaRetryCount: {
			envVarName: 'SUPERVISOR_DELTA_RETRY_COUNT',
			varType: 'int',
			defaultValue: '30',
		},
		deltaRetryInterval: {
			envVarName: 'SUPERVISOR_DELTA_RETRY_INTERVAL',
			varType: 'int',
			defaultValue: '10000',
		},
		deltaVersion: {
			envVarName: 'SUPERVISOR_DELTA_VERSION',
			varType: 'int',
			defaultValue: '2',
		},
		lockOverride: {
			envVarName: 'SUPERVISOR_OVERRIDE_LOCK',
			varType: 'bool',
			defaultValue: 'false',
		},
		persistentLogging: {
			envVarName: 'SUPERVISOR_PERSISTENT_LOGGING',
			varType: 'bool',
			defaultValue: 'false',
			rebootRequired: true,
		},
	};

	public static validKeys = [
		'SUPERVISOR_VPN_CONTROL',
		'OVERRIDE_LOCK',
		..._.map(DeviceConfig.configKeys, 'envVarName'),
	];

	private rateLimits: Dictionary<{
		duration: number;
		lastAttempt: number | null;
	}> = {
		setVPNEnabled: {
			// Only try to switch the VPN once an hour
			duration: 60 * 60 * 1000,
			lastAttempt: null,
		},
	};

	public constructor({ db, config, logger }: DeviceConfigConstructOpts) {
		this.db = db;
		this.config = config;
		this.logger = logger;

		this.actionExecutors = {
			changeConfig: async step => {
				try {
					if (step.humanReadableTarget) {
						this.logger.logConfigChange(step.humanReadableTarget);
					}
					if (!_.isObject(step.target)) {
						throw new Error('Non-dictionary value passed to changeConfig');
					}
					// TODO: Change the typing of step so that the types automatically
					// work out and we don't need this cast to any
					await this.config.set(step.target as { [key in SchemaTypeKey]: any });
					if (step.humanReadableTarget) {
						this.logger.logConfigChange(step.humanReadableTarget, {
							success: true,
						});
					}
					if (step.rebootRequired) {
						this.rebootRequired = true;
					}
				} catch (err) {
					if (step.humanReadableTarget) {
						this.logger.logConfigChange(step.humanReadableTarget, {
							err,
						});
					}
					throw err;
				}
			},
			setVPNEnabled: async (step, opts = {}) => {
				const { initial = false } = opts;
				if (!_.isString(step.target)) {
					throw new Error('Non-string value passed to setVPNEnabled');
				}
				const logValue = { SUPERVISOR_VPN_CONTROL: step.target };
				if (!initial) {
					this.logger.logConfigChange(logValue);
				}
				try {
					await this.setVPNEnabled(step.target);
					if (!initial) {
						this.logger.logConfigChange(logValue, { success: true });
					}
				} catch (err) {
					this.logger.logConfigChange(logValue, { err });
					throw err;
				}
			},
			setBootConfig: async step => {
				const configBackend = await this.getConfigBackend();
				if (!_.isObject(step.target)) {
					throw new Error(
						'Non-dictionary passed to DeviceConfig.setBootConfig',
					);
				}
				await this.setBootConfig(
					configBackend,
					step.target as Dictionary<string>,
				);
			},
		};
	}

	private async getConfigBackend() {
		if (this.configBackend != null) {
			return this.configBackend;
		}
		const dt = await this.config.get('deviceType');

		this.configBackend = configUtils.getConfigBackend(dt) || null;

		return this.configBackend;
	}

	public async setTarget(
		target: Dictionary<string>,
		trx?: Transaction,
	): Promise<void> {
		const db = trx != null ? trx : this.db.models.bind(this.db);

		const formatted = await this.formatConfigKeys(target);
		// check for legacy keys
		if (formatted['OVERRIDE_LOCK'] != null) {
			formatted['SUPERVISOR_OVERRIDE_LOCK'] = formatted['OVERRIDE_LOCK'];
		}

		const confToUpdate = {
			targetValues: JSON.stringify(formatted),
		};

		await db('deviceConfig').update(confToUpdate);
	}

	public async getTarget({ initial = false }: { initial?: boolean } = {}) {
		const [unmanaged, [devConfig]] = await Promise.all([
			this.config.get('unmanaged'),
			this.db.models('deviceConfig').select('targetValues'),
		]);

		let conf: Dictionary<string>;
		try {
			conf = JSON.parse(devConfig.targetValues);
		} catch (e) {
			throw new Error(`Corrupted supervisor database! Error: ${e.message}`);
		}
		if (initial || conf.SUPERVISOR_VPN_CONTROL == null) {
			conf.SUPERVISOR_VPN_CONTROL = 'true';
		}
		if (unmanaged && conf.SUPERVISOR_LOCAL_MODE == null) {
			conf.SUPERVISOR_LOCAL_MODE = 'true';
		}

		_.defaults(
			conf,
			_(DeviceConfig.configKeys)
				.mapKeys('envVarName')
				.mapValues('defaultValue')
				.value(),
		);

		return conf;
	}

	public async getCurrent() {
		const conf = await this.config.getMany(
			['deviceType'].concat(_.keys(DeviceConfig.configKeys)) as SchemaTypeKey[],
		);

		const configBackend = await this.getConfigBackend();

		const [vpnStatus, bootConfig] = await Promise.all([
			this.getVPNEnabled(),
			this.getBootConfig(configBackend),
		]);

		const currentConf: Dictionary<string> = {
			// TODO: Fix this mess of half strings half boolean values everywhere
			SUPERVISOR_VPN_CONTROL: vpnStatus != null ? vpnStatus.toString() : 'true',
		};

		for (const key of _.keys(DeviceConfig.configKeys)) {
			const { envVarName } = DeviceConfig.configKeys[key];
			const confValue = conf[key as SchemaTypeKey];
			currentConf[envVarName] = confValue != null ? confValue.toString() : '';
		}

		return _.assign(currentConf, bootConfig);
	}

	public async formatConfigKeys(
		conf: Dictionary<string>,
	): Promise<Dictionary<any>> {
		const backend = await this.getConfigBackend();
		return await configUtils.formatConfigKeys(
			backend,
			DeviceConfig.validKeys,
			conf,
		);
	}

	public getDefaults() {
		return _.extend(
			{
				SUPERVISOR_VPN_CONTROL: 'true',
			},
			_.mapValues(
				_.mapKeys(DeviceConfig.configKeys, 'envVarName'),
				'defaultValue',
			),
		);
	}

	public resetRateLimits() {
		_.each(this.rateLimits, action => {
			action.lastAttempt = null;
		});
	}

	private bootConfigChangeRequired(
		configBackend: DeviceConfigBackend | null,
		current: Dictionary<string>,
		target: Dictionary<string>,
		deviceType: string,
	): boolean {
		const targetBootConfig = configUtils.envToBootConfig(configBackend, target);
		const currentBootConfig = configUtils.envToBootConfig(
			configBackend,
			current,
		);

		// Some devices require specific overlays, here we apply them
		DeviceConfig.ensureRequiredOverlay(deviceType, targetBootConfig);

		if (!_.isEqual(currentBootConfig, targetBootConfig)) {
			_.each(targetBootConfig, (value, key) => {
				// Ignore null check because we can't get here if configBackend is null
				if (!configBackend!.isSupportedConfig(key)) {
					if (currentBootConfig[key] !== value) {
						const err = `Attempt to change blacklisted config value ${key}`;
						this.logger.logSystemMessage(
							err,
							{ error: err },
							'Apply boot config error',
						);
						throw new Error(err);
					}
				}
			});
			return true;
		}
		return false;
	}

	public async getRequiredSteps(
		currentState: DeviceStatus,
		targetState: { local?: { config?: Dictionary<string> } },
	): Promise<ConfigStep[]> {
		const current: Dictionary<string> = _.get(
			currentState,
			['local', 'config'],
			{},
		);
		const target: Dictionary<string> = _.get(
			targetState,
			['local', 'config'],
			{},
		);

		let steps: ConfigStep[] = [];

		const { deviceType, unmanaged } = await this.config.getMany([
			'deviceType',
			'unmanaged',
		]);
		const backend = await this.getConfigBackend();

		const configChanges: Dictionary<string> = {};
		const humanReadableConfigChanges: Dictionary<string> = {};
		let reboot = false;

		_.each(
			DeviceConfig.configKeys,
			({ envVarName, varType, rebootRequired, defaultValue }, key) => {
				let changingValue: null | string = null;
				// Test if the key is different
				if (
					!DeviceConfig.configTest(
						varType,
						current[envVarName],
						target[envVarName],
					)
				) {
					// Check that the difference is not due to the variable having an invalid
					// value set from the cloud
					if (
						this.config.valueIsValid(key as SchemaTypeKey, target[envVarName])
					) {
						// Save the change if it is both valid and different
						changingValue = target[envVarName];
					} else {
						if (
							!DeviceConfig.configTest(
								varType,
								current[envVarName],
								defaultValue,
							)
						) {
							const message = `Warning: Ignoring invalid device configuration value for ${key}, value: ${inspect(
								target[envVarName],
							)}. Falling back to default (${defaultValue})`;
							this.logger.logSystemMessage(
								message,
								{ key: envVarName, value: target[envVarName] },
								'invalidDeviceConfig',
								false,
							);
							// Set it to the default value if it is different to the current
							changingValue = defaultValue;
						}
					}
					if (changingValue != null) {
						configChanges[key] = changingValue;
						humanReadableConfigChanges[envVarName] = changingValue;
						reboot = rebootRequired || reboot;
					}
				}
			},
		);

		if (!_.isEmpty(configChanges)) {
			steps.push({
				action: 'changeConfig',
				target: configChanges,
				humanReadableTarget: humanReadableConfigChanges,
				rebootRequired: reboot,
			});
		}

		// Check for special case actions for the VPN
		if (
			!unmanaged &&
			!_.isEmpty(target['SUPERVISOR_VPN_CONTROL']) &&
			DeviceConfig.checkBoolChanged(current, target, 'SUPERVISOR_VPN_CONTROL')
		) {
			steps.push({
				action: 'setVPNEnabled',
				target: target['SUPERVISOR_VPN_CONTROL'],
			});
		}

		const now = Date.now();
		steps = _.map(steps, step => {
			const action = step.action;
			if (action in this.rateLimits) {
				const lastAttempt = this.rateLimits[action].lastAttempt;
				this.rateLimits[action].lastAttempt = now;

				// If this step should be rate limited, we replace it with a noop.
				// We do this instead of removing it, as we don't actually want the
				// state engine to think that it's successfully applied the target state,
				// as it won't reattempt the change until the target state changes
				if (
					lastAttempt != null &&
					Date.now() - lastAttempt < this.rateLimits[action].duration
				) {
					return { action: 'noop' } as ConfigStep;
				}
			}
			return step;
		});

		// Do we need to change the boot config?
		if (this.bootConfigChangeRequired(backend, current, target, deviceType)) {
			steps.push({
				action: 'setBootConfig',
				target,
			});
		}

		// Check if there is either no steps, or they are all
		// noops, and we need to reboot. We want to do this
		// because in a preloaded setting with no internet
		// connection, the device will try to start containers
		// before any boot config has been applied, which can
		// cause problems
		if (_.every(steps, { action: 'noop' }) && this.rebootRequired) {
			steps.push({
				action: 'reboot',
			});
		}

		return steps;
	}

	public executeStepAction(step: ConfigStep, opts: DeviceActionExecutorOpts) {
		if (step.action !== 'reboot' && step.action !== 'noop') {
			return this.actionExecutors[step.action](step, opts);
		}
	}

	public isValidAction(action: string): boolean {
		return _.includes(_.keys(this.actionExecutors), action);
	}

	private async getBootConfig(
		backend: DeviceConfigBackend | null,
	): Promise<EnvVarObject> {
		if (backend == null) {
			return {};
		}
		const conf = await backend.getBootConfig();
		return configUtils.bootConfigToEnv(backend, conf);
	}

	private async setBootConfig(
		backend: DeviceConfigBackend | null,
		target: Dictionary<string>,
	) {
		if (backend == null) {
			return false;
		}

		const conf = configUtils.envToBootConfig(backend, target);
		this.logger.logSystemMessage(
			`Applying boot config: ${JSON.stringify(conf)}`,
			{},
			'Apply boot config in progress',
		);

		// Ensure devices already have required overlays
		DeviceConfig.ensureRequiredOverlay(
			await this.config.get('deviceType'),
			conf,
		);

		try {
			await backend.setBootConfig(conf);
			this.logger.logSystemMessage(
				`Applied boot config: ${JSON.stringify(conf)}`,
				{},
				'Apply boot config success',
			);
			this.rebootRequired = true;
			return true;
		} catch (err) {
			this.logger.logSystemMessage(
				`Error setting boot config: ${err}`,
				{ error: err },
				'Apply boot config error',
			);
			throw err;
		}
	}

	private async getVPNEnabled(): Promise<boolean> {
		try {
			const activeState = await systemd.serviceActiveState(vpnServiceName);
			return !_.includes(['inactive', 'deactivating'], activeState);
		} catch (e) {
			if (UnitNotLoadedError(e)) {
				return false;
			}
			throw e;
		}
	}

	private async setVPNEnabled(value?: string | boolean) {
		const v = checkTruthy(value || true);
		const enable = v != null ? v : true;

		if (enable) {
			await systemd.startService(vpnServiceName);
		} else {
			await systemd.stopService(vpnServiceName);
		}
	}

	private static configTest(method: string, a: string, b: string): boolean {
		switch (method) {
			case 'bool':
				return checkTruthy(a) === checkTruthy(b);
			case 'int':
				return checkInt(a) === checkInt(b);
			default:
				throw new Error('Incorrect datatype passed to DeviceConfig.configTest');
		}
	}

	private static checkBoolChanged(
		current: Dictionary<string>,
		target: Dictionary<string>,
		key: string,
	): boolean {
		return checkTruthy(current[key]) !== checkTruthy(target[key]);
	}

	// Modifies conf
	private static ensureRequiredOverlay(
		deviceType: string,
		conf: ConfigOptions,
	) {
		switch (deviceType) {
			case 'fincm3':
				this.ensureDtoverlay(conf, 'balena-fin');
				break;
			case 'raspberrypi4-64':
				this.ensureDtoverlay(conf, 'vc4-fkms-v3d');
				break;
		}

		return conf;
	}

	// Modifies conf
	private static ensureDtoverlay(conf: ConfigOptions, field: string) {
		if (conf.dtoverlay == null) {
			conf.dtoverlay = [];
		} else if (_.isString(conf.dtoverlay)) {
			conf.dtoverlay = [conf.dtoverlay];
		}
		if (!_.includes(conf.dtoverlay, field)) {
			conf.dtoverlay.push(field);
		}
		conf.dtoverlay = conf.dtoverlay.filter(s => !_.isEmpty(s));

		return conf;
	}
}

export default DeviceConfig;
