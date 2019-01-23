import * as Bluebird from 'bluebird';
import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as _ from 'lodash';
import * as Path from 'path';
import { PinejsClientRequest } from 'pinejs-client-request';
import * as deviceRegister from 'resin-register-device';
import * as url from 'url';

import Config from './config';
import Database from './db';
import DeviceConfig from './device-config';
import { EventTracker } from './event-tracker';

import * as constants from './lib/constants';
import {
	DuplicateUuidError,
	ExchangeKeyError,
	InternalInconsistencyError,
} from './lib/errors';
import { pathExistsOnHost } from './lib/fs-utils';
import { request, requestOpts } from './lib/request';
import { writeLock } from './lib/update-lock';
import { DeviceApplicationState } from './types/state';

import { SchemaReturn as ConfigSchemaType } from './config/schema-type';

const REPORT_SUCCESS_DELAY = 1000;
const MAX_REPORT_RETRY_DELAY = 60000;

const INTERNAL_STATE_KEYS = [
	'update_pending',
	'update_downloaded',
	'update_failed',
];

interface APIBinderConstructOpts {
	config: Config;
	// FIXME: Remove this
	db: Database;
	// TODO: Typings
	deviceState: {
		deviceConfig: DeviceConfig;
		[key: string]: any;
	};
	eventTracker: EventTracker;
}

interface Device {
	id: number;

	[key: string]: unknown;
}

interface DevicePinInfo {
	app: number;
	commit: string;
}

type KeyExchangeOpts = ConfigSchemaType<'provisioningOptions'>;

export class APIBinder {
	public router: express.Router;

	private config: Config;
	private deviceState: {
		deviceConfig: DeviceConfig;
		[key: string]: any;
	};
	private eventTracker: EventTracker;

	private balenaApi: PinejsClientRequest | null = null;
	private cachedBalenaApi: PinejsClientRequest | null = null;
	private lastReportedState: DeviceApplicationState = {
		local: {},
		dependent: {},
	};
	private stateForReport: DeviceApplicationState = {
		local: {},
		dependent: {},
	};
	private lastTarget: DeviceApplicationState = {};
	private lastTargetStateFetch = process.hrtime();
	private reportPending = false;
	private stateReportErrors = 0;
	private targetStateFetchErrors = 0;
	private readyForUpdates = false;

	public constructor({
		config,
		deviceState,
		eventTracker,
	}: APIBinderConstructOpts) {
		this.config = config;
		this.deviceState = deviceState;
		this.eventTracker = eventTracker;

		this.router = this.createAPIBinderRouter(this);
	}

	public async healthcheck() {
		const {
			appUpdatePollInterval,
			unmanaged,
			connectivityCheckEnabled,
		} = await this.config.getMany([
			'appUpdatePollInterval',
			'unmanaged',
			'connectivityCheckEnabled',
		]);

		if (unmanaged) {
			return true;
		}

		if (appUpdatePollInterval == null) {
			return false;
		}

		const timeSinceLastFetch = process.hrtime(this.lastTargetStateFetch);
		const timeSinceLastFetchMs =
			timeSinceLastFetch[0] * 1000 + timeSinceLastFetch[1] / 1e6;
		const stateFetchHealthy = timeSinceLastFetchMs < 2 * appUpdatePollInterval;
		const stateReportHealthy =
			!connectivityCheckEnabled ||
			!this.deviceState.connected ||
			this.stateReportErrors < 3;

		return stateFetchHealthy && stateReportHealthy;
	}

	public async initClient() {
		const { unmanaged, apiEndpoint, currentApiKey } = await this.config.getMany(
			['unmanaged', 'apiEndpoint', 'currentApiKey'],
		);

		if (unmanaged) {
			console.log('Unmanaged mode is set, skipping API client initialization');
			return;
		}

		const baseUrl = url.resolve(apiEndpoint, '/v5/');
		const passthrough = _.cloneDeep(requestOpts);
		passthrough.headers =
			passthrough.headers != null ? passthrough.headers : {};
		passthrough.headers.Authorization = `Bearer ${currentApiKey}`;
		this.balenaApi = new PinejsClientRequest({
			apiPrefix: baseUrl,
			passthrough,
		});
		this.cachedBalenaApi = this.balenaApi.clone({}, { cache: {} });
	}

	public async loadBackupFromMigration(retryDelay: number): Promise<void> {
		try {
			const exists = await pathExistsOnHost(
				Path.join('mnt/data', constants.migrationBackupFile),
			);
			if (!exists) {
				return;
			}
			console.log('Migration backup detected');
			const targetState = await this.getTargetState();
			await this.deviceState.restoreBackup(targetState);
		} catch (err) {
			console.log('Error restoring migration backup, retrying: ', err);

			await Bluebird.delay(retryDelay);
			return this.loadBackupFromMigration(retryDelay);
		}
	}

	public async start() {
		const conf = await this.config.getMany([
			'apiEndpoint',
			'unmanaged',
			'bootstrapRetryDelay',
		]);
		let { apiEndpoint } = conf;
		const { unmanaged, bootstrapRetryDelay } = conf;

		if (unmanaged) {
			console.log('Unmanaged mode is set, skipping API binder initialization');
			// If we are offline because there is no apiEndpoint, there's a chance
			// we've went through a deprovision. We need to set the initialConfigReported
			// value to '', to ensure that when we do re-provision, we'll report
			// the config and hardward-specific options won't be lost
			if (!apiEndpoint) {
				await this.config.set({ initialConfigReported: '' });
			}
			return;
		}

		console.log('Ensuring device is provisioned');
		await this.provisionDevice();
		const conf2 = await this.config.getMany([
			'initialConfigReported',
			'apiEndpoint',
		]);
		apiEndpoint = conf2.apiEndpoint;
		const { initialConfigReported } = conf2;

		// Either we haven't reported our initial config or we've been re-provisioned
		if (apiEndpoint !== initialConfigReported) {
			console.log('Reporting initial configuration');
			await this.reportInitialConfig(apiEndpoint, bootstrapRetryDelay);
		}

		console.log('Starting current state report');
		await this.startCurrentStateReport();

		await this.loadBackupFromMigration(bootstrapRetryDelay);

		this.readyForUpdates = true;
		console.log('Starting target state poll');
		this.startTargetStatePoll();
	}

	public async fetchDevice(
		uuid: string,
		apiKey: string,
		timeout: number,
	): Promise<Device | null> {
		const reqOpts = {
			resource: 'device',
			options: {
				$filter: {
					uuid,
				},
			},
			passthrough: {
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			},
		};

		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'fetchDevice called without an initialized API client',
			);
		}

		try {
			const res = (await this.balenaApi
				.get(reqOpts)
				.timeout(timeout)) as Device[];
			return res[0];
		} catch (e) {
			return null;
		}
	}

	public async patchDevice(id: number, updatedFields: Dictionary<unknown>) {
		const conf = await this.config.getMany([
			'unmanaged',
			'provisioned',
			'apiTimeout',
		]);

		if (conf.unmanaged) {
			throw new Error('Cannot update device in unmanaged mode');
		}

		if (!conf.provisioned) {
			throw new Error('DEvice must be provisioned to update a device');
		}

		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to patch device without an API client',
			);
		}

		return this.balenaApi
			.patch({
				resource: 'device',
				id,
				body: updatedFields,
			})
			.timeout(conf.apiTimeout);
	}

	public async provisionDependentDevice(device: Device): Promise<Device> {
		const conf = await this.config.getMany([
			'unmanaged',
			'provisioned',
			'apiTimeout',
			'userId',
			'deviceId',
		]);

		if (conf.unmanaged) {
			throw new Error('Cannot provision dependent device in unmanaged mode');
		}
		if (!conf.provisioned) {
			throw new Error(
				'Device must be provisioned to provision a dependent device',
			);
		}
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to provision a dependent device without an API client',
			);
		}

		// TODO: When API supports it as per  https://github.com/resin-io/hq/pull/949 remove userId
		_.defaults(device, {
			belongs_to__user: conf.userId,
			is_managed_by__device: conf.deviceId,
			uuid: deviceRegister.generateUniqueKey(),
			registered_at: Math.floor(Date.now() / 1000),
		});

		return (await this.balenaApi
			.post({ resource: 'device', body: device })
			// TODO: Remove the `as number` when we fix the config typings
			.timeout(conf.apiTimeout)) as Device;
	}

	public async getTargetState(): Promise<DeviceApplicationState> {
		const { uuid, apiEndpoint, apiTimeout } = await this.config.getMany([
			'uuid',
			'apiEndpoint',
			'apiTimeout',
		]);

		if (!_.isString(apiEndpoint)) {
			throw new InternalInconsistencyError(
				'Non-string apiEndpoint passed to ApiBinder.getTargetState',
			);
		}
		if (this.cachedBalenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to get target state without an API client',
			);
		}

		const endpoint = url.resolve(apiEndpoint, `/device/v2/${uuid}/state`);
		const requestParams = _.extend(
			{ method: 'GET', url: endpoint },
			this.cachedBalenaApi.passthrough,
		);

		return await this.cachedBalenaApi
			._request(requestParams)
			.timeout(apiTimeout);
	}

	// TODO: Once 100% typescript, change this to a native promise
	public startTargetStatePoll(): Bluebird<null> {
		return Bluebird.try(() => {
			if (this.balenaApi == null) {
				throw new InternalInconsistencyError(
					'Trying to start poll without initializing API client',
				);
			}
			this.pollTargetState();
			return null;
		});
	}

	public startCurrentStateReport() {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Trying to start state reporting without initializing API client',
			);
		}
		this.deviceState.on('change', () => {
			if (!this.reportPending) {
				// A latency of 100ms should be acceptable and
				// allows avoiding catching docker at weird states
				this.reportCurrentState();
			}
		});
		return this.reportCurrentState();
	}

	private getStateDiff(): DeviceApplicationState {
		const lastReportedLocal = this.lastReportedState.local;
		const lastReportedDependent = this.lastReportedState.dependent;
		if (lastReportedLocal == null || lastReportedDependent == null) {
			throw new InternalInconsistencyError(
				`No local or dependent component of lastReportedLocal in ApiBinder.getStateDiff: ${JSON.stringify(
					this.lastReportedState,
				)}`,
			);
		}

		const diff = {
			local: _(this.stateForReport.local)
				.omitBy((val, key: keyof DeviceApplicationState['local']) =>
					_.isEqual(lastReportedLocal[key], val),
				)
				.omit(INTERNAL_STATE_KEYS)
				.value(),
			dependent: _(this.stateForReport.dependent)
				.omitBy((val, key: keyof DeviceApplicationState['dependent']) =>
					_.isEqual(lastReportedDependent[key], val),
				)
				.omit(INTERNAL_STATE_KEYS)
				.value(),
		};

		return _.omitBy(diff, _.isEmpty);
	}

	private async sendReportPatch(
		stateDiff: DeviceApplicationState,
		conf: { apiEndpoint: string; uuid: string },
	) {
		if (this.cachedBalenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to send report patch without an API client',
			);
		}

		const endpoint = url.resolve(
			conf.apiEndpoint,
			`/device/v2/${conf.uuid}/state`,
		);

		const requestParams = _.extend(
			{
				method: 'PATCH',
				url: endpoint,
				body: stateDiff,
			},
			this.cachedBalenaApi.passthrough,
		);

		await this.cachedBalenaApi._request(requestParams);
	}

	private async report() {
		const conf = await this.config.getMany([
			'deviceId',
			'apiTimeout',
			'apiEndpoint',
			'uuid',
			'localMode',
		]);

		if (conf.localMode) {
			return;
		}

		const stateDiff = this.getStateDiff();
		if (_.size(stateDiff) === 0) {
			return 0;
		}

		const apiEndpoint = conf.apiEndpoint;
		const uuid = conf.uuid;
		if (uuid == null || apiEndpoint == null) {
			throw new InternalInconsistencyError(
				'No uuid or apiEndpoint provided to ApiBinder.report',
			);
		}

		await Bluebird.resolve(
			this.sendReportPatch(stateDiff, { apiEndpoint, uuid }),
		).timeout(conf.apiTimeout);

		this.stateReportErrors = 0;
		_.assign(this.lastReportedState.local, stateDiff.local);
		_.assign(this.lastReportedState.dependent, stateDiff.dependent);
	}

	private reportCurrentState(): null {
		(async () => {
			this.reportPending = true;
			try {
				const currentDeviceState = await this.deviceState.getStatus();
				_.assign(this.stateForReport.local, currentDeviceState.local);
				_.assign(this.stateForReport.dependent, currentDeviceState.dependent);

				const stateDiff = this.getStateDiff();
				if (_.size(stateDiff) === 0) {
					this.reportPending = false;
					return null;
				}

				await this.report();
				await Bluebird.delay(REPORT_SUCCESS_DELAY);
				await this.reportCurrentState();
			} catch (e) {
				this.eventTracker.track('Device state report failure', { error: e });
				const delay = Math.min(
					2 ** this.stateReportErrors * 500,
					MAX_REPORT_RETRY_DELAY,
				);

				++this.stateReportErrors;
				await Bluebird.delay(delay);
				await this.reportCurrentState();
			}
		})();
		return null;
	}

	private getAndSetTargetState(force: boolean, isFromApi = false) {
		return Bluebird.using(this.lockGetTarget(), async () => {
			const targetState = await this.getTargetState();
			if (isFromApi || !_.isEqual(targetState, this.lastTarget)) {
				await this.deviceState.setTarget(targetState);
				this.lastTarget = _.cloneDeep(targetState);
				this.deviceState.triggerApplyTarget({ force });
			}
		})
			.tapCatch(err => {
				console.error(`Failed to get target state for device: ${err}`);
			})
			.finally(() => {
				this.lastTargetStateFetch = process.hrtime();
			});
	}

	private async pollTargetState(): Promise<void> {
		// TODO: Remove the checkInt here with the config changes
		let pollInterval = await this.config.get('appUpdatePollInterval');

		try {
			await this.getAndSetTargetState(false);
			this.targetStateFetchErrors = 0;
		} catch (e) {
			pollInterval = Math.min(
				pollInterval,
				15000 * 2 ** this.targetStateFetchErrors,
			);
			++this.targetStateFetchErrors;
		}

		await Bluebird.delay(pollInterval);
		await this.pollTargetState();
	}

	private async pinDevice({ app, commit }: DevicePinInfo) {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to pin device without an API client',
			);
		}

		try {
			const deviceId = await this.config.get('deviceId');

			if (deviceId == null) {
				throw new InternalInconsistencyError(
					'Device ID not defined in ApiBinder.pinDevice',
				);
			}

			const release = await this.balenaApi.get({
				resource: 'release',
				options: {
					$filter: {
						belongs_to__application: app,
						commit,
						status: 'success',
					},
					$select: 'id',
				},
			});

			const releaseId = _.get(release, '[0].id');
			if (releaseId == null) {
				throw new Error(
					'Cannot continue pinning preloaded device! No release found!',
				);
			}

			await this.balenaApi.patch({
				resource: 'device',
				id: deviceId,
				body: {
					should_be_running__release: releaseId,
				},
			});

			// Set the config value for pinDevice to null, so that we know the
			// task has been completed
			await this.config.remove('pinDevice');
		} catch (e) {
			console.log('Could not pin device to release!');
			console.log('Error: ', e);
			throw e;
		}
	}

	// Creates the necessary config vars in the API to match the current device state,
	// without overwriting any variables that are already set.
	private async reportInitialEnv(apiEndpoint: string) {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to report initial environment without an API client',
			);
		}

		const targetConfigUnformatted = _.get(
			await this.getTargetState(),
			'local.config',
		);
		if (targetConfigUnformatted == null) {
			throw new InternalInconsistencyError(
				'Attempt to report initial state with malformed target state',
			);
		}

		const defaultConfig = this.deviceState.deviceConfig.getDefaults();

		const currentState = await this.deviceState.getCurrentForComparison();
		const targetConfig = await this.deviceState.deviceConfig.formatConfigKeys(
			targetConfigUnformatted,
		);
		const deviceId = await this.config.get('deviceId');

		const currentConfig: Dictionary<string> = currentState.local.config;
		for (const [key, value] of _.toPairs(currentConfig)) {
			let varValue = value;
			// We want to disable local mode when joining a cloud
			if (key === 'SUPERVISOR_LOCAL_MODE') {
				varValue = 'false';
			}
			// We never want to disable VPN if, for instance, it failed to start so far
			if (key === 'SUPERVISOR_VPN_CONTROL') {
				varValue = 'true';
			}

			if (targetConfig[key] == null && value !== defaultConfig[key]) {
				const envVar = {
					value: varValue,
					device: deviceId,
					name: 'RESIN_' + key,
				};
				await this.balenaApi.post({
					resource: 'device_config_variable',
					body: envVar,
				});
			}
		}

		await this.config.set({ initialConfigReported: apiEndpoint });
	}

	private async reportInitialConfig(
		apiEndpoint: string,
		retryDelay: number,
	): Promise<void> {
		try {
			await this.reportInitialEnv(apiEndpoint);
		} catch (err) {
			console.error('Error reporting initial configuration, will retry', err);
			await Bluebird.delay(retryDelay);
			this.reportInitialConfig(apiEndpoint, retryDelay);
		}
	}

	private async exchangeKeyAndGetDevice(
		opts?: KeyExchangeOpts,
	): Promise<Device> {
		if (opts == null) {
			opts = await this.config.get('provisioningOptions');
		}

		const uuid = opts.uuid;
		const apiTimeout = opts.apiTimeout;
		if (!(uuid && apiTimeout)) {
			throw new InternalInconsistencyError(
				'UUID and apiTimeout should be defined in exchangeKeyAndGetDevice',
			);
		}

		// If we have an existing device key we first check if it's
		// valid, becaise of ot os we can just use that
		if (opts.deviceApiKey != null) {
			const device = await this.fetchDevice(
				uuid,
				opts.deviceApiKey,
				apiTimeout,
			);
			if (device != null) {
				return device;
			}
		}

		// If it's not valid or doesn't exist then we try to use the
		// user/provisioning api key for the exchange
		if (!opts.provisioningApiKey) {
			throw new InternalInconsistencyError(
				'Required a provisioning key in exchangeKeyAndGetDevice',
			);
		}
		const device = await this.fetchDevice(
			uuid,
			opts.provisioningApiKey,
			apiTimeout,
		);

		if (device == null) {
			throw new ExchangeKeyError(`Couldn't fetch device with provisioning key`);
		}

		// We found the device so we can try to register a working device key for it
		const [res] = await request
			.postAsync(`${opts.apiEndpoint}/api-key/device/${device.id}/device-key`, {
				json: true,
				body: {
					apiKey: opts.deviceApiKey,
				},
				headers: {
					Authorization: `Bearer ${opts.provisioningApiKey}`,
				},
			})
			.timeout(apiTimeout);

		if (res.statusCode !== 200) {
			throw new ExchangeKeyError(
				`Couldn't register device key with provisioning key`,
			);
		}

		return device;
	}

	private async exchangeKeyAndGetDeviceOrRegenerate(
		opts?: KeyExchangeOpts,
	): Promise<Device> {
		try {
			const device = await this.exchangeKeyAndGetDevice(opts);
			console.log('Key exchange succeeded');
			return device;
		} catch (e) {
			if (e instanceof ExchangeKeyError) {
				console.log('Exchanging key failed, re-registering...');
				await this.config.regenerateRegistrationFields();
			}
			throw e;
		}
	}

	private async provision() {
		let device: Device | null = null;
		// FIXME: Config typing
		const opts = await this.config.get('provisioningOptions');
		if (
			opts.registered_at != null &&
			opts.deviceId != null &&
			opts.provisioningApiKey == null
		) {
			return;
		}

		if (opts.registered_at != null && opts.deviceId == null) {
			console.log(
				'Device is registered but no device id available, attempting key exchange',
			);
			device = (await this.exchangeKeyAndGetDeviceOrRegenerate(opts)) || null;
		} else if (opts.registered_at == null) {
			console.log('New device detected. Provisioning...');
			try {
				device = await deviceRegister.register(opts).timeout(opts.apiTimeout);
				opts.registered_at = Date.now();
			} catch (err) {
				if (DuplicateUuidError(err)) {
					console.log('UUID already registered, trying a key exchange');
					await this.exchangeKeyAndGetDeviceOrRegenerate(opts);
				} else {
					throw err;
				}
			}
		} else if (opts.provisioningApiKey != null) {
			console.log(
				'Device is registered but we still have an apiKey, attempting key exchange',
			);
			device = await this.exchangeKeyAndGetDevice(opts);
		}

		if (!device) {
			// TODO: Type this?
			throw new Error(`Failed to provision device!`);
		}
		const { id } = device;
		if (!this.balenaApi) {
			throw new InternalInconsistencyError(
				'Attempting to provision a device without an initialized API client',
			);
		}
		this.balenaApi.passthrough.headers.Authorization = `Bearer ${
			opts.deviceApiKey
		}`;

		const configToUpdate = {
			registered_at: opts.registered_at,
			deviceId: id,
			apiKey: null,
		};
		await this.config.set(configToUpdate);
		this.eventTracker.track('Device bootstrap success');

		// Now check if we need to pin the device
		const pinValue = await this.config.get('pinDevice');

		if (pinValue != null) {
			if (pinValue.app == null || pinValue.commit == null) {
				console.log(
					`Malformed pinDEvice fields in supervisor database: ${pinValue}`,
				);
				return;
			}
			console.log('Attempting to pin device to preloaded release...');
			return this.pinDevice(pinValue);
		}
	}

	private async provisionOrRetry(retryDelay: number): Promise<void> {
		this.eventTracker.track('Device bootstrap');
		try {
			await this.provision();
		} catch (e) {
			this.eventTracker.track(`Device bootstrap failed, retrying`, {
				error: e,
				delay: retryDelay,
			});
			await Bluebird.delay(retryDelay);
			this.provisionOrRetry(retryDelay);
		}
	}

	private async provisionDevice() {
		if (this.balenaApi == null) {
			throw new Error(
				'Trying to provision a device without initializing API client',
			);
		}
		const conf = await this.config.getMany([
			'provisioned',
			'bootstrapRetryDelay',
			'apiKey',
			'pinDevice',
		]);

		if (!conf.provisioned || conf.apiKey != null || conf.pinDevice != null) {
			return this.provisionOrRetry(conf.bootstrapRetryDelay as number);
		}

		return conf;
	}

	private lockGetTarget() {
		return writeLock('getTarget').disposer(release => {
			release();
		});
	}

	private createAPIBinderRouter(apiBinder: APIBinder): express.Router {
		const router = express.Router();

		router.use(bodyParser.urlencoded({ extended: true }));
		router.use(bodyParser.json());

		router.post('/v1/update', (req, res) => {
			apiBinder.eventTracker.track('Update notification');
			if (apiBinder.readyForUpdates) {
				apiBinder.getAndSetTargetState(req.body.force, true).catch(_.noop);
			}
			res.sendStatus(204);
		});

		return router;
	}
}
