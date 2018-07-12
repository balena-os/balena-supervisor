import * as Bluebird from 'bluebird';
import { Transaction } from 'knex';
import * as _ from 'lodash';

import Config = require('../config');
import DB = require('../db');
import supervisorVersion = require('../lib/supervisor-version');

import * as constants from '../lib/constants';
import * as osRelease from '../lib/os-release';
import { ConfigValue } from '../lib/types';

// A provider for schema entries with source 'func'
type ConfigProviderFunctionGetter = () => Bluebird<any>;
type ConfigProviderFunctionSetter = (value: ConfigValue, tx?: Transaction) => Bluebird<void>;
type ConfigProviderFunctionRemover = () => Bluebird<void>;

interface ConfigProviderFunction {
	get: ConfigProviderFunctionGetter;
	set?: ConfigProviderFunctionSetter;
	remove?: ConfigProviderFunctionRemover;
}

export interface ConfigProviderFunctions {
	[key: string]: ConfigProviderFunction;
}

export function createProviderFunctions(config: Config, db: DB): ConfigProviderFunctions {
	return {
		logsChannelSecret: {
			get: () => {
				// Return the logsChannelSecret which corresponds to the current backend
				return config.get('apiEndpoint')
					.then((backend = '') => {
						return db.models('logsChannelSecret').select('secret').where({ backend });
					})
					.then(([ conf ]) => {
						if (conf != null) {
							return conf.secret;
						}
						return;
					});
			},
			set: (value: string, tx?: Transaction) => {
				// Store the secret with the current backend
				return config.get('apiEndpoint')
					.then((backend: string) => {
						return db.upsertModel(
							'logsChannelSecret',
							{ backend: backend || '', secret: value },
							{ backend: backend || '' },
							tx,
						);
					});
			},
			remove: () => {
				return config.get('apiEndpoint')
					.then((backend) => {
						return db.models('logsChannelSecret').where({ backend: backend || '' }).del();
					});
			},
		},
		version: {
			get: () => {
				return Bluebird.resolve(supervisorVersion);
			},
		},
		currentApiKey: {
			get: () => {
				return config.getMany([ 'apiKey', 'deviceApiKey' ])
					.then(({ apiKey, deviceApiKey }) => {
						return apiKey || deviceApiKey;
					});
			},
		},
		offlineMode: {
			get: () => {
				return config.getMany([ 'apiEndpoint', 'supervisorOfflineMode' ])
					.then(({ apiEndpoint, supervisorOfflineMode }) => {
						return Boolean(supervisorOfflineMode) || !Boolean(apiEndpoint);
					});
			},
		},
		pubnub: {
			get: () => {
				return config.getMany([ 'pubnubSubscribeKey', 'pubnubPublishKey' ])
					.then(({ pubnubSubscribeKey, pubnubPublishKey }) => {
						return {
							subscribe_key: pubnubSubscribeKey,
							publish_key: pubnubPublishKey,
							ssl: true,
						};
					});
			},
		},
		provisioned: {
			get: () => {
				return config.getMany([
					'uuid',
					'apiEndpoint',
					'registered_at',
					'deviceId',
				])
					.then((requiredValues) => {
						return _.every(_.values(requiredValues), Boolean);
					});
			},
		},
		osVersion: {
			get: () => {
				return osRelease.getOSVersion(constants.hostOSVersionPath);
			},
		},
		osVariant: {
			get: () => {
				return osRelease.getOSVariant(constants.hostOSVersionPath);
			},
		},
		provisioningOptions: {
			get: () => {
				return config.getMany([
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
				]).then((conf) => {
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
		},
		mixpanelHost: {
			get: () => {
				return config.get('apiEndpoint')
					.then((apiEndpoint) => {
						return `${apiEndpoint}/mixpanel`;
					});
			},
		},
		extendedEnvOptions: {
			get: () => {
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
		},
		fetchOptions: {
			get: () => {
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
		},
	};
}
