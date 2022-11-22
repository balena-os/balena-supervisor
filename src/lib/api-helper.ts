import { PinejsClientRequest } from 'pinejs-client-request';

import Bluebird from 'bluebird';
import * as config from '../config';
import * as eventTracker from '../event-tracker';

import * as request from './request';
import * as deviceRegister from './register-device';
import {
	DeviceNotFoundError,
	ExchangeKeyError,
	FailedToProvisionDeviceError,
	InternalInconsistencyError,
	isHttpConflictError,
} from './errors';
import log from './supervisor-console';

export type KeyExchangeOpts = config.ConfigType<'provisioningOptions'>;

export interface Device {
	id: number;

	[key: string]: unknown;
}

export const fetchDevice = async (
	balenaApi: PinejsClientRequest,
	uuid: string,
	apiKey: string,
	timeout: number,
) => {
	if (balenaApi == null) {
		throw new InternalInconsistencyError(
			'fetchDevice called without an initialized API client',
		);
	}

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

	try {
		const [device] = (await Bluebird.resolve(balenaApi.get(reqOpts)).timeout(
			timeout,
		)) as Device[];

		if (device == null) {
			throw new DeviceNotFoundError();
		}

		return device;
	} catch {
		throw new DeviceNotFoundError();
	}
};

export const exchangeKeyAndGetDeviceOrRegenerate = async (
	balenaApi: PinejsClientRequest,
	opts: KeyExchangeOpts,
): Promise<Device> => {
	try {
		const device = await exchangeKeyAndGetDevice(balenaApi, opts);
		log.debug('Key exchange succeeded');
		return device;
	} catch (e) {
		if (e instanceof ExchangeKeyError) {
			log.error('Exchanging key failed, re-registering...');
			await config.regenerateRegistrationFields();
		}
		throw e;
	}
};

export const exchangeKeyAndGetDevice = async (
	balenaApi: PinejsClientRequest,
	opts: Partial<KeyExchangeOpts>,
): Promise<Device> => {
	const uuid = opts.uuid;
	const apiTimeout = opts.apiTimeout;
	if (!(uuid && apiTimeout)) {
		throw new InternalInconsistencyError(
			'UUID and apiTimeout should be defined in exchangeKeyAndGetDevice',
		);
	}

	// If we have an existing device key we first check if it's
	// valid, because if it is then we can just use that
	if (opts.deviceApiKey != null) {
		try {
			return await fetchDevice(balenaApi, uuid, opts.deviceApiKey, apiTimeout);
		} catch (e) {
			if (e instanceof DeviceNotFoundError) {
				// do nothing...
			} else {
				throw e;
			}
		}
	}

	// If it's not valid or doesn't exist then we try to use the
	// user/provisioning api key for the exchange
	if (!opts.provisioningApiKey) {
		throw new InternalInconsistencyError(
			'Required a provisioning key in exchangeKeyAndGetDevice',
		);
	}

	let device: Device;
	try {
		device = await fetchDevice(
			balenaApi,
			uuid,
			opts.provisioningApiKey,
			apiTimeout,
		);
	} catch {
		throw new ExchangeKeyError(`Couldn't fetch device with provisioning key`);
	}

	// We found the device so we can try to register a working device key for it
	const [res] = await (
		await request.getRequestInstance()
	)
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
};

export const provision = async (
	balenaApi: PinejsClientRequest,
	opts: KeyExchangeOpts,
) => {
	await config.initialized();

	let device: Device | null = null;

	if (
		opts.registered_at == null ||
		opts.deviceId == null ||
		opts.provisioningApiKey != null
	) {
		if (opts.registered_at != null && opts.deviceId == null) {
			log.debug(
				'Device is registered but no device id available, attempting key exchange',
			);

			device = await exchangeKeyAndGetDeviceOrRegenerate(balenaApi, opts);
		} else if (opts.registered_at == null) {
			if (opts.provisioningApiKey == null) {
				throw new Error('Cannot provision without a provisioning api key');
			}
			if (opts.applicationId == null) {
				throw new Error('Cannot provision without an application id');
			}
			if (opts.uuid == null) {
				throw new Error('Cannot provision without a uuid');
			}
			log.info('New device detected. Provisioning...');
			try {
				device = await Bluebird.resolve(
					deviceRegister.register({
						applicationId: opts.applicationId,
						uuid: opts.uuid,
						deviceType: opts.deviceType,
						deviceApiKey: opts.deviceApiKey,
						provisioningApiKey: opts.provisioningApiKey,
						apiEndpoint: opts.apiEndpoint,
						supervisorVersion: opts.supervisorVersion,
						osVersion: opts.osVersion,
						osVariant: opts.osVariant,
						macAddress: opts.macAddress,
					}),
				).timeout(opts.apiTimeout);
			} catch (err) {
				if (
					err instanceof deviceRegister.ApiError &&
					isHttpConflictError(err.response)
				) {
					log.debug('UUID already registered, trying a key exchange');
					device = await exchangeKeyAndGetDeviceOrRegenerate(balenaApi, opts);
				} else {
					throw err;
				}
			}
			opts.registered_at = Date.now();
		} else if (opts.provisioningApiKey != null) {
			log.debug(
				'Device is registered but we still have an apiKey, attempting key exchange',
			);
			device = await exchangeKeyAndGetDevice(balenaApi, opts);
		}

		if (!device) {
			throw new FailedToProvisionDeviceError();
		}

		const { id } = device;
		balenaApi.passthrough.headers.Authorization = `Bearer ${opts.deviceApiKey}`;

		const configToUpdate = {
			registered_at: opts.registered_at,
			deviceId: id,
			apiKey: null,
		};

		await config.set(configToUpdate);
		eventTracker.track('Device bootstrap success');
	}

	return device;
};
