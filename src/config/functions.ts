import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { URL } from 'url';

import supervisorVersion = require('../lib/supervisor-version');

import Config from '.';
import * as constants from '../lib/constants';
import * as osRelease from '../lib/os-release';

type ConfigProviderFunction = () => Bluebird<any>;

export interface ConfigProviderFunctions {
	[key: string]: ConfigProviderFunction;
}

export function createProviderFunctions(
	config: Config,
): ConfigProviderFunctions {
	return {
		version: () => {
			return Bluebird.resolve(supervisorVersion);
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
				.then(requiredValues => {
					return _.every(_.values(requiredValues), Boolean);
				});
		},
		osVersion: () => {
			return osRelease.getOSVersion(constants.hostOSVersionPath);
		},
		osVariant: () => {
			return osRelease.getOSVariant(constants.hostOSVersionPath);
		},
		provisioningOptions: () => {
			return config
				.getMany([
					'uuid',
					'userId',
					'applicationId',
					'apiKey',
					'deviceApiKey',
					'deviceType',
					'apiEndpoint',
					'apiTimeout',
					'registered_at',
					'deviceId',
				])
				.then(conf => {
					return {
						uuid: conf.uuid,
						applicationId: conf.applicationId,
						userId: conf.userId,
						deviceType: conf.deviceType,
						provisioningApiKey: conf.apiKey,
						deviceApiKey: conf.deviceApiKey,
						apiEndpoint: conf.apiEndpoint,
						apiTimeout: conf.apiTimeout,
						registered_at: conf.registered_at,
						deviceId: conf.deviceId,
					};
				});
		},
		mixpanelHost: () => {
			return config.get('apiEndpoint').then(apiEndpoint => {
				if (!apiEndpoint) {
					return null;
				}
				const url = new URL(apiEndpoint as string);
				return { host: url.host, path: '/mixpanel' };
			});
		},
		extendedEnvOptions: () => {
			return config.getMany([
				'uuid',
				'listenPort',
				'name',
				'apiSecret',
				'deviceApiKey',
				'version',
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
			return config.get('apiEndpoint').then(apiEndpoint => {
				return !apiEndpoint;
			});
		},
	};
}
