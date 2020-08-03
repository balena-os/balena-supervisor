import * as Bluebird from 'bluebird';
import * as bodyParser from 'body-parser';
import { stripIndent } from 'common-tags';
import * as express from 'express';
import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import * as _ from 'lodash';
import { PinejsClientRequest } from 'pinejs-client-request';
import * as url from 'url';
import * as deviceRegister from './lib/register-device';

import * as config from './config';
import * as deviceConfig from './device-config';
import * as eventTracker from './event-tracker';
import { loadBackupFromMigration } from './lib/migration';

import {
	ContractValidationError,
	ContractViolationError,
	ExchangeKeyError,
	InternalInconsistencyError,
	isHttpConflictError,
} from './lib/errors';
import * as request from './lib/request';

import log from './lib/supervisor-console';

import DeviceState from './device-state';
import * as globalEventBus from './event-bus';
import * as TargetState from './device-state/target-state';
import * as CurrentState from './device-state/current-state';
import * as logger from './logger';

interface Device {
	id: number;

	[key: string]: unknown;
}

interface DevicePinInfo {
	app: number;
	commit: string;
}

interface DeviceTag {
	id: number;
	name: string;
	value: string;
}

type KeyExchangeOpts = config.ConfigType<'provisioningOptions'>;

export class APIBinder {
	public router: express.Router;

	private deviceState: DeviceState;

	public balenaApi: PinejsClientRequest | null = null;
	private readyForUpdates = false;

	public constructor() {
		this.router = this.createAPIBinderRouter(this);
	}

	public setDeviceState(deviceState: DeviceState) {
		this.deviceState = deviceState;
	}

	public async healthcheck() {
		const {
			appUpdatePollInterval,
			unmanaged,
			connectivityCheckEnabled,
		} = await config.getMany([
			'appUpdatePollInterval',
			'unmanaged',
			'connectivityCheckEnabled',
		]);

		// Don't have to perform checks for unmanaged
		if (unmanaged) {
			return true;
		}

		if (appUpdatePollInterval == null) {
			log.info(
				'Healthcheck failure - Config value `appUpdatePollInterval` cannot be null',
			);
			return false;
		}

		// Check last time target state has been polled
		const timeSinceLastFetch = process.hrtime(TargetState.lastFetch);
		const timeSinceLastFetchMs =
			timeSinceLastFetch[0] * 1000 + timeSinceLastFetch[1] / 1e6;

		if (!(timeSinceLastFetchMs < 2 * appUpdatePollInterval)) {
			log.info(
				'Healthcheck failure - Device has not fetched target state within appUpdatePollInterval limit',
			);
			return false;
		}

		// Check if state report is healthy
		const stateReportHealthy =
			!connectivityCheckEnabled ||
			!this.deviceState.connected ||
			CurrentState.stateReportErrors < 3;

		if (!stateReportHealthy) {
			log.info(
				stripIndent`
				Healthcheck failure - At least ONE of the following conditions must be true:
					- No connectivityCheckEnabled   ? ${!(connectivityCheckEnabled === true)}
					- device state is disconnected  ? ${!(this.deviceState.connected === true)}
					- stateReportErrors less then 3 ? ${CurrentState.stateReportErrors < 3}`,
			);
			return false;
		}

		// All tests pass!
		return true;
	}

	public async initClient() {
		const { unmanaged, apiEndpoint, currentApiKey } = await config.getMany([
			'unmanaged',
			'apiEndpoint',
			'currentApiKey',
		]);

		if (unmanaged) {
			log.debug('Unmanaged mode is set, skipping API client initialization');
			return;
		}

		const baseUrl = url.resolve(apiEndpoint, '/v6/');
		const passthrough = _.cloneDeep(await request.getRequestOptions());
		passthrough.headers =
			passthrough.headers != null ? passthrough.headers : {};
		passthrough.headers.Authorization = `Bearer ${currentApiKey}`;
		this.balenaApi = new PinejsClientRequest({
			apiPrefix: baseUrl,
			passthrough,
		});
	}

	public async start() {
		const conf = await config.getMany([
			'apiEndpoint',
			'unmanaged',
			'bootstrapRetryDelay',
			'initialDeviceName',
		]);
		let { apiEndpoint } = conf;
		const { unmanaged, bootstrapRetryDelay } = conf;

		if (unmanaged) {
			log.info('Unmanaged mode is set, skipping API binder initialization');
			// If we are offline because there is no apiEndpoint, there's a chance
			// we've went through a deprovision. We need to set the initialConfigReported
			// value to '', to ensure that when we do re-provision, we'll report
			// the config and hardward-specific options won't be lost
			if (!apiEndpoint) {
				await config.set({ initialConfigReported: '' });
			}
			return;
		}

		log.debug('Ensuring device is provisioned');
		await this.provisionDevice();
		const conf2 = await config.getMany([
			'initialConfigReported',
			'apiEndpoint',
		]);
		apiEndpoint = conf2.apiEndpoint;
		const { initialConfigReported } = conf2;

		// Either we haven't reported our initial config or we've been re-provisioned
		if (apiEndpoint !== initialConfigReported) {
			log.info('Reporting initial configuration');
			// We fetch the deviceId here to ensure it's been set
			const deviceId = await config.get('deviceId');
			if (deviceId == null) {
				throw new InternalInconsistencyError(
					`Attempt to report initial configuration without a device ID`,
				);
			}
			await this.reportInitialConfig(
				apiEndpoint,
				deviceId,
				bootstrapRetryDelay,
				conf.initialDeviceName ?? undefined,
			);
		}

		log.debug('Starting current state report');
		await CurrentState.startReporting(this.deviceState);

		// When we've provisioned, try to load the backup. We
		// must wait for the provisioning because we need a
		// target state on which to apply the backup
		globalEventBus.getInstance().once('targetStateChanged', async (state) => {
			await loadBackupFromMigration(
				this.deviceState,
				state,
				bootstrapRetryDelay,
			);
		});

		this.readyForUpdates = true;
		log.debug('Starting target state poll');
		TargetState.startPoll();
		TargetState.emitter.on(
			'target-state-update',
			async (targetState, force, isFromApi) => {
				try {
					await this.deviceState.setTarget(targetState);
					this.deviceState.triggerApplyTarget({ force, isFromApi });
				} catch (err) {
					if (
						err instanceof ContractValidationError ||
						err instanceof ContractViolationError
					) {
						log.error(`Could not store target state for device: ${err}`);
						// the dashboard does not display lines correctly,
						// split them explcitly here
						const lines = err.message.split(/\r?\n/);
						lines[0] = `Could not move to new release: ${lines[0]}`;
						for (const line of lines) {
							logger.logSystemMessage(line, {}, 'targetStateRejection', false);
						}
					} else {
						log.error(`Failed to get target state for device: ${err}`);
					}
				}
			},
		);
	}

	public async fetchDevice(
		uuid: string,
		apiKey: string,
		timeout: number,
	): Promise<Device | null> {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'fetchDevice called without an initialized API client',
			);
		}

		try {
			return (await Bluebird.resolve(
				this.balenaApi.get({
					resource: 'device',
					id: {
						uuid,
					},
					passthrough: {
						headers: {
							Authorization: `Bearer ${apiKey}`,
						},
					},
				}),
			).timeout(timeout)) as Device;
		} catch (e) {
			return null;
		}
	}

	public async patchDevice(id: number, updatedFields: Dictionary<unknown>) {
		const conf = await config.getMany([
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

		return Bluebird.resolve(
			this.balenaApi.patch({
				resource: 'device',
				id,
				body: updatedFields,
			}),
		).timeout(conf.apiTimeout);
	}

	public async provisionDependentDevice(device: Device): Promise<Device> {
		const conf = await config.getMany([
			'unmanaged',
			'provisioned',
			'apiTimeout',
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

		_.defaults(device, {
			is_managed_by__device: conf.deviceId,
			uuid: deviceRegister.generateUniqueKey(),
			registered_at: Math.floor(Date.now() / 1000),
		});

		return (await Bluebird.resolve(
			this.balenaApi.post({ resource: 'device', body: device }),
		).timeout(conf.apiTimeout)) as Device;
	}

	public async fetchDeviceTags(): Promise<DeviceTag[]> {
		if (this.balenaApi == null) {
			throw new Error(
				'Attempt to communicate with API, without initialized client',
			);
		}

		const deviceId = await config.get('deviceId');
		if (deviceId == null) {
			throw new Error('Attempt to retrieve device tags before provision');
		}
		const tags = (await this.balenaApi.get({
			resource: 'device_tag',
			id: deviceId,
			options: {
				$select: ['id', 'tag_key', 'value'],
			},
		})) as Array<Dictionary<unknown>>;

		return tags.map((tag) => {
			// Do some type safe decoding and throw if we get an unexpected value
			const id = t.number.decode(tag.id);
			const name = t.string.decode(tag.tag_key);
			const value = t.string.decode(tag.value);
			if (isLeft(id) || isLeft(name) || isLeft(value)) {
				throw new Error(
					`There was an error parsing device tags from the api. Device tag: ${JSON.stringify(
						tag,
					)}`,
				);
			}
			return {
				id: id.right,
				name: name.right,
				value: value.right,
			};
		});
	}

	private async pinDevice({ app, commit }: DevicePinInfo) {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to pin device without an API client',
			);
		}

		try {
			const deviceId = await config.get('deviceId');

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
			await config.remove('pinDevice');
		} catch (e) {
			log.error(`Could not pin device to release! ${e}`);
			throw e;
		}
	}

	// Creates the necessary config vars in the API to match the current device state,
	// without overwriting any variables that are already set.
	private async reportInitialEnv(
		apiEndpoint: string,
		deviceId: number,
		initialName?: string,
	) {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to report initial environment without an API client',
			);
		}

		// We force a fresh get to make sure we have the latest state
		// and can guarantee we don't clash with any already reported config
		const targetConfigUnformatted = (await TargetState.get())?.local?.config;
		if (targetConfigUnformatted == null) {
			throw new InternalInconsistencyError(
				'Attempt to report initial state with malformed target state',
			);
		}

		const defaultConfig = deviceConfig.getDefaults();

		const currentState = await this.deviceState.getCurrentForComparison();
		const targetConfig = await deviceConfig.formatConfigKeys(
			targetConfigUnformatted,
		);

		if (!currentState.local.config) {
			throw new InternalInconsistencyError(
				'No config defined in reportInitialEnv',
			);
		}
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

			if (targetConfig[key] == null && varValue !== defaultConfig[key]) {
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

		if (initialName != null) {
			await this.reportInitialName(deviceId, initialName);
		}

		await config.set({ initialConfigReported: apiEndpoint });
	}

	private async reportInitialConfig(
		apiEndpoint: string,
		deviceId: number,
		retryDelay: number,
		initialName?: string,
	): Promise<void> {
		try {
			await this.reportInitialEnv(apiEndpoint, deviceId, initialName);
		} catch (err) {
			log.error('Error reporting initial configuration, will retry', err);
			await Bluebird.delay(retryDelay);
			await this.reportInitialConfig(
				apiEndpoint,
				deviceId,
				retryDelay,
				initialName,
			);
		}
	}

	private async exchangeKeyAndGetDevice(
		opts?: KeyExchangeOpts,
	): Promise<Device> {
		if (opts == null) {
			opts = await config.get('provisioningOptions');
		}

		const uuid = opts.uuid;
		const apiTimeout = opts.apiTimeout;
		if (!(uuid && apiTimeout)) {
			throw new InternalInconsistencyError(
				'UUID and apiTimeout should be defined in exchangeKeyAndGetDevice',
			);
		}

		// If we have an existing device key we first check if it's
		// valid, becaise of it is we can just use that
		if (opts.deviceApiKey != null) {
			const deviceFromApi = await this.fetchDevice(
				uuid,
				opts.deviceApiKey,
				apiTimeout,
			);
			if (deviceFromApi != null) {
				return deviceFromApi;
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
		const [res] = await (await request.getRequestInstance())
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
			log.debug('Key exchange succeeded');
			return device;
		} catch (e) {
			if (e instanceof ExchangeKeyError) {
				log.error('Exchanging key failed, re-registering...');
				await config.regenerateRegistrationFields();
			}
			throw e;
		}
	}

	private async provision() {
		let device: Device | null = null;
		const opts = await config.get('provisioningOptions');
		if (
			opts.registered_at == null ||
			opts.deviceId == null ||
			opts.provisioningApiKey != null
		) {
			if (opts.registered_at != null && opts.deviceId == null) {
				log.debug(
					'Device is registered but no device id available, attempting key exchange',
				);
				device = (await this.exchangeKeyAndGetDeviceOrRegenerate(opts)) || null;
			} else if (opts.registered_at == null) {
				log.info('New device detected. Provisioning...');
				try {
					device = await deviceRegister.register(opts).timeout(opts.apiTimeout);
				} catch (err) {
					if (
						err instanceof deviceRegister.ApiError &&
						isHttpConflictError(err.response)
					) {
						log.debug('UUID already registered, trying a key exchange');
						device = await this.exchangeKeyAndGetDeviceOrRegenerate(opts);
					} else {
						throw err;
					}
				}
				opts.registered_at = Date.now();
			} else if (opts.provisioningApiKey != null) {
				log.debug(
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
			this.balenaApi.passthrough.headers.Authorization = `Bearer ${opts.deviceApiKey}`;

			const configToUpdate = {
				registered_at: opts.registered_at,
				deviceId: id,
				apiKey: null,
			};
			await config.set(configToUpdate);
			eventTracker.track('Device bootstrap success');
		}

		// Now check if we need to pin the device
		const pinValue = await config.get('pinDevice');

		if (pinValue != null) {
			if (pinValue.app == null || pinValue.commit == null) {
				log.error(
					`Malformed pinDevice fields in supervisor database: ${pinValue}`,
				);
				return;
			}
			log.info('Attempting to pin device to preloaded release...');
			return this.pinDevice(pinValue);
		}
	}

	private async provisionOrRetry(retryDelay: number): Promise<void> {
		eventTracker.track('Device bootstrap');
		try {
			await this.provision();
		} catch (e) {
			eventTracker.track(`Device bootstrap failed, retrying`, {
				error: e,
				delay: retryDelay,
			});
			await Bluebird.delay(retryDelay);
			return this.provisionOrRetry(retryDelay);
		}
	}

	private async provisionDevice() {
		if (this.balenaApi == null) {
			throw new Error(
				'Trying to provision a device without initializing API client',
			);
		}
		const conf = await config.getMany([
			'provisioned',
			'bootstrapRetryDelay',
			'apiKey',
			'pinDevice',
		]);

		if (!conf.provisioned || conf.apiKey != null || conf.pinDevice != null) {
			await this.provisionOrRetry(conf.bootstrapRetryDelay);
			globalEventBus.getInstance().emit('deviceProvisioned');
			return;
		}

		return conf;
	}

	private createAPIBinderRouter(apiBinder: APIBinder): express.Router {
		const router = express.Router();

		router.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
		router.use(bodyParser.json({ limit: '10mb' }));

		router.post('/v1/update', (req, res, next) => {
			eventTracker.track('Update notification');
			if (apiBinder.readyForUpdates) {
				config
					.get('instantUpdates')
					.then((instantUpdates) => {
						if (instantUpdates) {
							TargetState.update(req.body.force, true).catch(_.noop);
							res.sendStatus(204);
						} else {
							log.debug(
								'Ignoring update notification because instant updates are disabled',
							);
							res.sendStatus(202);
						}
					})
					.catch(next);
			} else {
				res.sendStatus(202);
			}
		});

		return router;
	}

	private async reportInitialName(
		deviceId: number,
		name: string,
	): Promise<void> {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				`Attempt to set an initial device name without an API client`,
			);
		}

		await this.balenaApi.patch({
			resource: 'device',
			id: deviceId,
			body: {
				device_name: name,
			},
		});
	}
}

export default APIBinder;
