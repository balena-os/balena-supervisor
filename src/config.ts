import * as Bluebird from 'bluebird';
import { EventEmitter } from 'events';
import { Transaction } from 'knex';
import * as _ from 'lodash';
import { generateUniqueKey } from 'resin-register-device';

import ConfigJsonConfigBackend from './config/configJson';

import * as constants from './lib/constants';
import * as osRelease from './lib/os-release';
import { ConfigMap, ConfigSchema, ConfigValue } from './lib/types';

import DB = require('./db');
import supervisorVersion = require('./lib/supervisor-version');

interface ConfigOpts {
	db: DB;
	configPath: string;
}

// A provider for schema entries with source 'func'
type ConfigFunction = (...args: any[]) => Bluebird<any>;

class Config extends EventEmitter {

	private db: DB;
	private configJsonBackend: ConfigJsonConfigBackend;

	private funcs: { [functionName: string]: ConfigFunction } = {
		version: () => {
			return Bluebird.resolve(supervisorVersion);
		},
		currentApiKey: () => {
			return this.getMany([ 'apiKey', 'deviceApiKey' ])
				.then(({ apiKey, deviceApiKey }) => {
					return apiKey || deviceApiKey;
				});
		},
		offlineMode: () => {
			return this.getMany([ 'resinApiEndpoint', 'supervisorOfflineMode' ])
				.then(({ resinApiEndpoint, supervisorOfflineMode }) => {
					return Boolean(supervisorOfflineMode) || !Boolean(resinApiEndpoint);
				});
		},
		pubnub: () => {
			return this.getMany([ 'pubnubSubscribeKey', 'pubnubPublishKey' ])
				.then(({ pubnubSubscribeKey, pubnubPublishKey }) => {
					return {
						subscribe_key: pubnubSubscribeKey,
						publish_key: pubnubPublishKey,
						ssl: true,
					};
				});
		},
		resinApiEndpoint: () => {
			// Fallback to checking if an API endpoint was passed via env vars if there's none
			// in config.json (legacy)
			return this.get('apiEndpoint')
				.then((apiEndpoint) => {
					return apiEndpoint || constants.apiEndpointFromEnv;
				});
		},
		provisioned: () => {
			return this.getMany([
				'uuid',
				'resinApiEndpoint',
				'registered_at',
				'deviceId',
			])
				.then((requiredValues) => {
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
			return this.getMany([
				'uuid',
				'userId',
				'applicationId',
				'apiKey',
				'deviceApiKey',
				'deviceType',
				'resinApiEndpoint',
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
					apiEndpoint: conf.resinApiEndpoint,
					apiTimeout: conf.apiTimeout,
					registered_at: conf.registered_at,
					deviceId: conf.deviceId,
				};
			});
		},
		mixpanelHost: () => {
			return this.get('resinApiEndpoint')
				.then((apiEndpoint) => {
					return `${apiEndpoint}/mixpanel`;
				});
		},
		extendedEnvOptions: () => {
			return this.getMany([
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
			return this.getMany([
				'uuid',
				'currentApiKey',
				'resinApiEndpoint',
				'deltaEndpoint',
				'delta',
				'deltaRequestTimeout',
				'deltaApplyTimeout',
				'deltaRetryCount',
				'deltaRetryInterval',
				'deltaVersion',
			]);
		},
	};

	public schema: ConfigSchema = {
		apiEndpoint: { source: 'config.json' },
		apiTimeout: { source: 'config.json', default: 15 * 60 * 1000 },
		listenPort: { source: 'config.json', default: 48484 },
		deltaEndpoint: { source: 'config.json', default: 'https://delta.resin.io' },
		uuid: { source: 'config.json', mutable: true },
		apiKey: { source: 'config.json', mutable: true, removeIfNull: true },
		deviceApiKey: { source: 'config.json', mutable: true },
		deviceType: { source: 'config.json', default: 'raspberry-pi' },
		username: { source: 'config.json' },
		userId: { source: 'config.json' },
		deviceId: { source: 'config.json', mutable: true },
		registered_at: { source: 'config.json', mutable: true },
		applicationId: { source: 'config.json' },
		appUpdatePollInterval: { source: 'config.json', mutable: true, default: 60000 },
		pubnubSubscribeKey: { source: 'config.json', default: constants.defaultPubnubSubscribeKey },
		pubnubPublishKey: { source: 'config.json', default: constants.defaultPubnubPublishKey },
		mixpanelToken: { source: 'config.json', default: constants.defaultMixpanelToken },
		bootstrapRetryDelay: { source: 'config.json', default: 30000 },
		supervisorOfflineMode: { source: 'config.json', default: false },
		hostname: { source: 'config.json', mutable: true },

		version: { source: 'func' },
		currentApiKey: { source: 'func' },
		offlineMode: { source: 'func' },
		pubnub: { source: 'func' },
		resinApiEndpoint: { source: 'func' },
		provisioned: { source: 'func' },
		osVersion: { source: 'func' },
		osVariant: { source: 'func' },
		provisioningOptions: { source: 'func' },
		mixpanelHost: { source: 'func' },
		extendedEnvOptions: { source: 'func' },
		fetchOptions: { source: 'func' },

		// NOTE: all 'db' values are stored and loaded as *strings*,
		apiSecret: { source: 'db', mutable: true },
		logsChannelSecret: { source: 'db', mutable: true },
		name: { source: 'db', mutable: true },
		initialConfigReported: { source: 'db', mutable: true, default: 'false' },
		initialConfigSaved: { source: 'db', mutable: true, default: 'false' },
		containersNormalised: { source: 'db', mutable: true, default: 'false' },
		localMode: { source: 'db', mutable: true, default: 'false' },
		loggingEnabled: { source: 'db', mutable: true, default: 'true' },
		connectivityCheckEnabled: { source: 'db', mutable: true, default: 'true' },
		delta: { source: 'db', mutable: true, default: 'false' },
		deltaRequestTimeout: { source: 'db', mutable: true, default: '30000' },
		deltaApplyTimeout: { source: 'db', mutable: true, default: '' },
		deltaRetryCount: { source: 'db', mutable: true, default: '30' },
		deltaRetryInterval: { source: 'db', mutable: true, default: '10000' },
		deltaVersion: { source: 'db', mutable: true, default: '2' },
		lockOverride: { source: 'db', mutable: true, default: 'false' },
		legacyAppsPresent: { source: 'db', mutable: true, default: 'false' },
		nativeLogger: { source: 'db', mutable: true, default: 'true' },
		// a JSON value, which is either null, or { app: number, commit: string }
		pinDevice: { source: 'db', mutable: true, default: 'null' },
	};

	public constructor({ db, configPath }: ConfigOpts) {
		super();
		this.db = db;
		this.configJsonBackend = new ConfigJsonConfigBackend(this.schema, configPath);
	}

	public init(): Bluebird<void> {
		return this.configJsonBackend.init()
			.then(() => {
				return this.generateRequiredFields();
			});
	}

	public get(key: string, trx?: Transaction): Bluebird<ConfigValue> {
		const db = trx || this.db.models.bind(this.db);

		return Bluebird.try(() => {
			if (this.schema[key] == null) {
				throw new Error(`Unknown config value ${key}`);
			}
			switch(this.schema[key].source) {
				case 'func':
					return this.funcs[key]()
						.catch((e) => {
							console.error(`Error getting config value for ${key}`, e, e.stack);
							return null;
						});
				case 'config.json':
					return this.configJsonBackend.get(key);
				case 'db':
					return db('config').select('value').where({ key })
						.then(([ conf ]: [{ value: string }]) => {
							if (conf != null) {
								return conf.value;
							}
							return;
						});
			}
		})
			.then((value) => {
				const schemaEntry = this.schema[key];
				if (value == null && schemaEntry != null && schemaEntry.default) {
					return schemaEntry.default;
				}
				return value;
			});
	}

	public getMany(keys: string[], trx?: Transaction): Bluebird<ConfigMap> {
		return Bluebird.map(keys, (key: string) => this.get(key, trx))
			.then((values) => {
				return _.zipObject(keys, values);
			});
	}

	public set(keyValues: ConfigMap, trx?: Transaction): Bluebird<void> {
		return Bluebird.try(() => {
			// Split the values into database and configJson values
			type SplitConfigBackend = { configJsonVals: ConfigMap, dbVals: ConfigMap };
			const { configJsonVals, dbVals }: SplitConfigBackend = _.reduce(keyValues, (acc: SplitConfigBackend, val, key) => {
				if (this.schema[key] == null || !this.schema[key].mutable) {
					throw new Error(`Config field ${key} not found or is immutable in config.set`);
				}
				if (this.schema[key].source === 'config.json') {
					acc.configJsonVals[key] = val;
				} else if (this.schema[key].source === 'db') {
					acc.dbVals[key] = val;
				} else {
					throw new Error(`Unknown config backend for key: ${key}, backend: ${this.schema[key].source}`);
				}
				return acc;
			}, { configJsonVals: { }, dbVals: { } });

			const setValuesInTransaction = (tx: Transaction): Bluebird<void> => {
				const dbKeys = _.keys(dbVals);
				return this.getMany(dbKeys, tx)
					.then((oldValues) => {
						return Bluebird.map(dbKeys, (key: string) => {
							const value = dbVals[key];
							if (oldValues[key] !== value) {
								return this.db.upsertModel('config', { key, value }, { key }, tx);
							}
						});
					})
					.then(() => {
						if (!_.isEmpty(configJsonVals)) {
							return this.configJsonBackend.set(configJsonVals);
						}
					});
			};

			if (trx != null) {
				return setValuesInTransaction(trx).return();
			} else {
				return this.db.transaction((tx) => {
					return setValuesInTransaction(tx);
				}).return();
			}

		})
			.then(() => {
				return setImmediate(() => {
					this.emit('change', keyValues);
				});
			});
	}

	public remove(key: string): Bluebird<void> {
		return Bluebird.try(() => {
			if (this.schema[key] == null || !this.schema[key].mutable) {
				throw new Error(`Attempt to delete non-existent or immutable key ${key}`);
			}
			if (this.schema[key].source === 'config.json') {
				return this.configJsonBackend.remove(key);
			} else if (this.schema[key].source === 'db') {
				return this.db.models('config').del().where({ key });
			} else {
				throw new Error(`Unknown or unsupported config backend: ${this.schema[key].source}`);
			}
		});
	}

	public regenerateRegistrationFields(): Bluebird<void> {
		return this.set({
			uuid: this.newUniqueKey(),
			deviceApiKey: this.newUniqueKey(),
		});
	}

	private newUniqueKey(): string {
		return generateUniqueKey();
	}

	private generateRequiredFields() {
		return this.getMany([
			'uuid',
			'deviceApiKey',
			'apiSecret',
			'logsChannelSecret',
			'offlineMode',
		])
			.then(({ uuid, deviceApiKey, apiSecret, logsChannelSecret, offlineMode }) => {
				// These fields need to be set regardless
				if (uuid == null || apiSecret == null) {
					uuid = uuid || this.newUniqueKey();
					apiSecret = apiSecret || this.newUniqueKey();
				}
				return this.set({ uuid, apiSecret })
					.then(() => {
						if (offlineMode) {
							return;
						}
						if (deviceApiKey == null || logsChannelSecret == null) {
							deviceApiKey = deviceApiKey || this.newUniqueKey();
							logsChannelSecret = logsChannelSecret || this.newUniqueKey();
							return this.set({ deviceApiKey, logsChannelSecret });
						}
					});
			});
	}
}

export = Config;
