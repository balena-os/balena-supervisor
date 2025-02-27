import _ from 'lodash';
import memoizee from 'memoizee';

import supervisorVersion = require('../lib/supervisor-version');

import * as config from '.';
import * as constants from '../lib/constants';
import * as osRelease from '../lib/os-release';
import * as macAddress from '../lib/mac-address';
import * as hostUtils from '../lib/host-utils';
import log from '../lib/supervisor-console';

export const fnSchema = {
	version: () => {
		return Promise.resolve(supervisorVersion);
	},
	currentApiKey: () => {
		return config
			.getMany(['apiKey', 'deviceApiKey'])
			.then(({ apiKey, deviceApiKey }) => {
				return apiKey || deviceApiKey;
			});
	},
	provisioned: () => {
		return config
			.getMany(['uuid', 'apiEndpoint', 'registered_at', 'deviceId'])
			.then((requiredValues) => {
				return _.every(_.values(requiredValues));
			});
	},
	osVersion: () => {
		return osRelease.getOSVersion(constants.hostOSVersionPath);
	},
	osVariant: async () => {
		const osVariant = await osRelease.getOSVariant(constants.hostOSVersionPath);
		if (osVariant === undefined) {
			const developmentMode = await config.get('developmentMode');
			return developmentMode === true ? 'dev' : 'prod';
		}
		return osVariant;
	},
	macAddress: () => {
		return macAddress.getAll(constants.macAddressPath);
	},
	deviceArch: memoizee(
		async () => {
			try {
				// FIXME: We should be mounting the following file into the supervisor from the
				// start-balena-supervisor script, changed in meta-balena - but until then, hardcode it
				const data = await hostUtils.readFromBoot(
					hostUtils.pathOnBoot('device-type.json'),
					'utf-8',
				);
				const deviceInfo = JSON.parse(data);

				return deviceInfo.arch;
			} catch (e) {
				log.error(`Unable to get architecture: ${e}`);
				throw e;
			}
		},
		{ promise: true },
	),
	deviceType: memoizee(
		async () => {
			try {
				// FIXME: We should be mounting the following file into the supervisor from the
				// start-balena-supervisor script, changed in meta-balena - but until then, hardcode it
				const data = await hostUtils.readFromBoot(
					hostUtils.pathOnBoot('device-type.json'),
					'utf-8',
				);
				const deviceInfo = JSON.parse(data);

				return deviceInfo.slug;
			} catch (e) {
				log.error(`Unable to get device type: ${e}`);
				throw e;
			}
		},
		{ promise: true },
	),
	provisioningOptions: () => {
		return config
			.getMany([
				'uuid',
				'applicationId',
				'apiKey',
				'deviceApiKey',
				'deviceArch',
				'deviceType',
				'apiEndpoint',
				'apiRequestTimeout',
				'registered_at',
				'deviceId',
				'version',
				'osVersion',
				'osVariant',
				'macAddress',
			])
			.then((conf) => {
				return {
					uuid: conf.uuid,
					applicationId: conf.applicationId,
					deviceArch: conf.deviceArch,
					deviceType: conf.deviceType,
					provisioningApiKey: conf.apiKey,
					deviceApiKey: conf.deviceApiKey,
					apiEndpoint: conf.apiEndpoint,
					apiRequestTimeout: conf.apiRequestTimeout,
					registered_at: conf.registered_at,
					deviceId: conf.deviceId,
					supervisorVersion: conf.version,
					osVersion: conf.osVersion,
					osVariant: conf.osVariant,
					macAddress: conf.macAddress,
				};
			});
	},
	extendedEnvOptions: () => {
		return config.getMany([
			'uuid',
			'listenPort',
			'name',
			'apiEndpoint',
			'deviceApiKey',
			'version',
			'deviceArch',
			'deviceType',
			'osVersion',
		]);
	},
	fetchOptions: () => {
		return config.getMany([
			'uuid',
			'currentApiKey',
			'apiEndpoint',
			'deltaEndpoint',
			'delta',
			'deltaRequestTimeout',
			'deltaApplyTimeout',
			'deltaRetryCount',
			'deltaRetryInterval',
			'deltaVersion',
		]);
	},
	unmanaged: () => {
		return config.get('apiEndpoint').then((apiEndpoint) => {
			return !apiEndpoint;
		});
	},
};

export type FnSchema = typeof fnSchema;
export type FnSchemaKey = keyof FnSchema;
