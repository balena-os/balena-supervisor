import * as Bluebird from 'bluebird';
import { stripIndent } from 'common-tags';
import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import * as _ from 'lodash';
import { PinejsClientRequest } from 'pinejs-client-request';
import * as url from 'url';

import { startReporting, stateReportErrors } from './report';
import * as config from '../config';
import * as deviceConfig from '../device-config';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import * as globalEventBus from '../event-bus';
import * as TargetState from '../device-state/target-state';
import * as logger from '../logger';

import { loadBackupFromMigration } from '../lib/migration';
import * as deviceRegister from '../lib/register-device';
import {
	ContractValidationError,
	ContractViolationError,
	InternalInconsistencyError,
	TargetStateError,
} from '../lib/errors';
import * as request from '../lib/request';
import log from '../lib/supervisor-console';
import * as apiHelper from '../lib/api-helper';

interface DevicePinInfo {
	app: number;
	commit: string;
}

interface DeviceTag {
	id: number;
	name: string;
	value: string;
}

let readyForUpdates = false;

export function isReadyForUpdates() {
	return readyForUpdates;
}

export async function healthcheck() {
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
		!deviceState.connected ||
		stateReportErrors < 3;

	if (!stateReportHealthy) {
		log.info(
			stripIndent`
			Healthcheck failure - At least ONE of the following conditions must be true:
				- No connectivityCheckEnabled   ? ${!(connectivityCheckEnabled === true)}
				- device state is disconnected  ? ${!(deviceState.connected === true)}
				- stateReportErrors less then 3 ? ${stateReportErrors < 3}`,
		);
		return false;
	}

	// All tests pass!
	return true;
}

export async function start() {
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
	await provisionDevice();
	const conf2 = await config.getMany(['initialConfigReported', 'apiEndpoint']);
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
		await reportInitialConfig(
			apiEndpoint,
			deviceId,
			bootstrapRetryDelay,
			conf.initialDeviceName ?? undefined,
		);
	}

	log.debug('Starting current state report');
	await startCurrentStateReport();

	// When we've provisioned, try to load the backup. We
	// must wait for the provisioning because we need a
	// target state on which to apply the backup
	globalEventBus.getInstance().once('targetStateChanged', async (state) => {
		await loadBackupFromMigration(state, bootstrapRetryDelay);
	});

	readyForUpdates = true;
	log.debug('Starting target state poll');
	TargetState.startPoll();
	// Update and apply new target state
	TargetState.emitter.on(
		'target-state-update',
		async (targetState, force, isFromApi) => {
			try {
				await deviceState.setTarget(targetState);
				deviceState.triggerApplyTarget({ force, isFromApi });
			} catch (err) {
				handleTargetUpdateError(err);
			}
		},
	);
	// Apply new target state
	TargetState.emitter.on('target-state-apply', (force, isFromApi) => {
		try {
			deviceState.triggerApplyTarget({ force, isFromApi });
		} catch (err) {
			handleTargetUpdateError(err);
		}
	});

	function handleTargetUpdateError(err: any) {
		if (
			err instanceof ContractValidationError ||
			err instanceof ContractViolationError ||
			err instanceof TargetStateError
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
}

export async function patchDevice(
	id: number,
	updatedFields: Dictionary<unknown>,
) {
	const conf = await config.getMany(['unmanaged', 'provisioned', 'apiTimeout']);

	if (conf.unmanaged) {
		throw new Error('Cannot update device in unmanaged mode');
	}

	if (!conf.provisioned) {
		throw new Error('Device must be provisioned to update a device');
	}

	if (balenaApi == null) {
		throw new InternalInconsistencyError(
			'Attempt to patch device without an API client',
		);
	}

	return Bluebird.resolve(
		balenaApi.patch({
			resource: 'device',
			id,
			body: updatedFields,
		}),
	).timeout(conf.apiTimeout);
}

export async function provisionDependentDevice(
	device: Partial<apiHelper.Device>,
): Promise<apiHelper.Device> {
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
	if (balenaApi == null) {
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
		balenaApi.post({ resource: 'device', body: device }),
	).timeout(conf.apiTimeout)) as apiHelper.Device;
}

export function startCurrentStateReport() {
	if (balenaApi == null) {
		throw new InternalInconsistencyError(
			'Trying to start state reporting without initializing API client',
		);
	}
	startReporting();
}

export async function fetchDeviceTags(): Promise<DeviceTag[]> {
	if (balenaApi == null) {
		throw new InternalInconsistencyError(
			'Attempt to communicate with API, without initialized client',
		);
	}

	const deviceId = await config.get('deviceId');
	if (deviceId == null) {
		throw new Error('Attempt to retrieve device tags before provision');
	}
	const tags = await balenaApi.get({
		resource: 'device_tag',
		options: {
			$select: ['id', 'tag_key', 'value'],
			$filter: { device: deviceId },
		},
	});

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
		return { id: id.right, name: name.right, value: value.right };
	});
}

async function pinDevice({ app, commit }: DevicePinInfo) {
	if (balenaApi == null) {
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

		const release = await balenaApi.get({
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

		const releaseId: number | undefined = release?.[0]?.id;
		if (releaseId == null) {
			throw new Error(
				'Cannot continue pinning preloaded device! No release found!',
			);
		}

		// We force a fresh get to make sure we have the latest state
		// and can guarantee we don't clash with any already reported config
		const uuid = await config.get('uuid');
		if (!uuid) {
			throw new InternalInconsistencyError('No uuid for local device');
		}

		const targetConfigUnformatted = (await TargetState.get())?.[uuid]?.config;
		if (targetConfigUnformatted == null) {
			throw new InternalInconsistencyError(
				'Attempt to report initial state with malformed target state',
			);
		}
		await balenaApi.patch({
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
async function reportInitialEnv(
	apiEndpoint: string,
	deviceId: number,
	initialName?: string,
) {
	if (balenaApi == null) {
		throw new InternalInconsistencyError(
			'Attempt to report initial environment without an API client',
		);
	}

	const uuid = await config.get('uuid');
	if (!uuid) {
		throw new InternalInconsistencyError('No uuid for local device');
	}

	const targetConfigUnformatted = (await TargetState.get())?.[uuid]?.config;
	if (targetConfigUnformatted == null) {
		throw new InternalInconsistencyError(
			'Attempt to report initial state with malformed target state',
		);
	}

	const defaultConfig = deviceConfig.getDefaults();

	const currentConfig = await deviceConfig.getCurrent();
	const targetConfig = deviceConfig.formatConfigKeys(targetConfigUnformatted);

	if (!currentConfig) {
		throw new InternalInconsistencyError(
			'No config defined in reportInitialEnv',
		);
	}
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
			await balenaApi.post({
				resource: 'device_config_variable',
				body: envVar,
			});
		}
	}

	if (initialName != null) {
		await reportInitialName(deviceId, initialName);
	}

	await config.set({ initialConfigReported: apiEndpoint });
}

async function reportInitialConfig(
	apiEndpoint: string,
	deviceId: number,
	retryDelay: number,
	initialName?: string,
): Promise<void> {
	try {
		await reportInitialEnv(apiEndpoint, deviceId, initialName);
	} catch (err) {
		log.error('Error reporting initial configuration, will retry', err);
		await Bluebird.delay(retryDelay);
		await reportInitialConfig(apiEndpoint, deviceId, retryDelay, initialName);
	}
}

async function provision() {
	if (!balenaApi) {
		throw new InternalInconsistencyError(
			'Attempting to provision a device without an initialized API client',
		);
	}

	const opts = await config.get('provisioningOptions');
	await apiHelper.provision(balenaApi, opts);

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
		return pinDevice(pinValue);
	}
}

async function provisionOrRetry(retryDelay: number): Promise<void> {
	eventTracker.track('Device bootstrap');
	try {
		await provision();
	} catch (e) {
		eventTracker.track(`Device bootstrap failed, retrying`, {
			error: e,
			delay: retryDelay,
		});
		await Bluebird.delay(retryDelay);
		return provisionOrRetry(retryDelay);
	}
}

async function provisionDevice() {
	if (balenaApi == null) {
		throw new Error(
			'Trying to provision a device without initializing API client',
		);
	}

	const conf = await config.getMany([
		'apiKey',
		'bootstrapRetryDelay',
		'pinDevice',
		'provisioned',
	]);

	if (!conf.provisioned || conf.apiKey != null || conf.pinDevice != null) {
		await provisionOrRetry(conf.bootstrapRetryDelay);
		globalEventBus.getInstance().emit('deviceProvisioned');
		return;
	}

	return conf;
}

async function reportInitialName(
	deviceId: number,
	name: string,
): Promise<void> {
	if (balenaApi == null) {
		throw new InternalInconsistencyError(
			`Attempt to set an initial device name without an API client`,
		);
	}

	try {
		await balenaApi.patch({
			resource: 'device',
			id: deviceId,
			body: {
				device_name: name,
			},
		});
	} catch (err) {
		log.error('Unable to report initial device name to API');
		logger.logSystemMessage(
			'Unable to report initial device name to API',
			err,
			'reportInitialNameError',
		);
	}
}

export let balenaApi: PinejsClientRequest | null = null;

export const initialized = (async () => {
	await config.initialized;
	await eventTracker.initialized;
	await deviceState.initialized;

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
	passthrough.headers = passthrough.headers != null ? passthrough.headers : {};
	passthrough.headers.Authorization = `Bearer ${currentApiKey}`;
	balenaApi = new PinejsClientRequest({
		apiPrefix: baseUrl,
		passthrough,
	});

	log.info(`API Binder bound to: ${baseUrl}`);
})();
