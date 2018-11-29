import * as Bluebird from 'bluebird';
import { EventEmitter } from 'events';
import { Transaction } from 'knex';
import * as _ from 'lodash';
import { generateUniqueKey } from 'resin-register-device';

import ConfigJsonConfigBackend from './configJson';

import { ConfigProviderFunctions, createProviderFunctions } from './functions';
import * as constants from '../lib/constants';
import { ConfigMap, ConfigSchema, ConfigValue } from '../lib/types';

import DB = require('../db');

interface ConfigOpts {
	db: DB;
	configPath: string;
}

class Config extends EventEmitter {
	private db: DB;
	private configJsonBackend: ConfigJsonConfigBackend;
	private providerFunctions: ConfigProviderFunctions;

	public schema: ConfigSchema = {
		apiEndpoint: { source: 'config.json', default: '' },
		apiTimeout: { source: 'config.json', default: 15 * 60 * 1000 },
		listenPort: { source: 'config.json', default: 48484 },
		deltaEndpoint: { source: 'config.json', default: 'https://delta.resin.io' },
		uuid: { source: 'config.json', mutable: true },
		apiKey: { source: 'config.json', mutable: true, removeIfNull: true },
		deviceApiKey: { source: 'config.json', mutable: true, default: '' },
		deviceType: { source: 'config.json', default: 'unknown' },
		username: { source: 'config.json' },
		userId: { source: 'config.json' },
		deviceId: { source: 'config.json', mutable: true },
		registered_at: { source: 'config.json', mutable: true },
		applicationId: { source: 'config.json' },
		appUpdatePollInterval: {
			source: 'config.json',
			mutable: true,
			default: 60000,
		},
		mixpanelToken: {
			source: 'config.json',
			default: constants.defaultMixpanelToken,
		},
		bootstrapRetryDelay: { source: 'config.json', default: 30000 },
		supervisorOfflineMode: { source: 'config.json', default: false },
		hostname: { source: 'config.json', mutable: true },
		persistentLogging: { source: 'config.json', default: false, mutable: true },
		localMode: { source: 'config.json', mutable: true, default: 'false' },

		version: { source: 'func' },
		currentApiKey: { source: 'func' },
		offlineMode: { source: 'func' },
		provisioned: { source: 'func' },
		osVersion: { source: 'func' },
		osVariant: { source: 'func' },
		provisioningOptions: { source: 'func' },
		mixpanelHost: { source: 'func' },
		extendedEnvOptions: { source: 'func' },
		fetchOptions: { source: 'func' },

		// NOTE: all 'db' values are stored and loaded as *strings*,
		apiSecret: { source: 'db', mutable: true },
		name: { source: 'db', mutable: true, default: 'local' },
		initialConfigReported: { source: 'db', mutable: true, default: 'false' },
		initialConfigSaved: { source: 'db', mutable: true, default: 'false' },
		containersNormalised: { source: 'db', mutable: true, default: 'false' },
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
		// a JSON value, which is either null, or { app: number, commit: string }
		pinDevice: { source: 'db', mutable: true, default: 'null' },
		currentCommit: { source: 'db', mutable: true },
		targetStateSet: { source: 'db', mutable: true, default: 'false' },
	};

	public constructor({ db, configPath }: ConfigOpts) {
		super();
		this.db = db;
		this.configJsonBackend = new ConfigJsonConfigBackend(
			this.schema,
			configPath,
		);
		this.providerFunctions = createProviderFunctions(this);
	}

	public init(): Bluebird<void> {
		return this.configJsonBackend.init().then(() => {
			return this.generateRequiredFields();
		});
	}

	public get(key: string, trx?: Transaction): Bluebird<ConfigValue> {
		const db = trx || this.db.models.bind(this.db);

		return Bluebird.try(() => {
			if (this.schema[key] == null) {
				throw new Error(`Unknown config value ${key}`);
			}
			switch (this.schema[key].source) {
				case 'func':
					return this.providerFunctions[key].get().catch(e => {
						console.error(`Error getting config value for ${key}`, e, e.stack);
						return null;
					});
				case 'config.json':
					return this.configJsonBackend.get(key);
				case 'db':
					return db('config')
						.select('value')
						.where({ key })
						.then(([conf]: [{ value: string }]) => {
							if (conf != null) {
								return conf.value;
							}
							return;
						});
			}
		}).then(value => {
			const schemaEntry = this.schema[key];
			if (value == null && schemaEntry != null && schemaEntry.default != null) {
				return schemaEntry.default;
			}
			return value;
		});
	}

	public getMany(keys: string[], trx?: Transaction): Bluebird<ConfigMap> {
		return Bluebird.map(keys, (key: string) => this.get(key, trx)).then(
			values => {
				return _.zipObject(keys, values);
			},
		);
	}

	public set(keyValues: ConfigMap, trx?: Transaction): Bluebird<void> {
		return Bluebird.try(() => {
			// Split the values based on which storage backend they use
			type SplitConfigBackend = {
				configJsonVals: ConfigMap;
				dbVals: ConfigMap;
				fnVals: ConfigMap;
			};
			const { configJsonVals, dbVals, fnVals }: SplitConfigBackend = _.reduce(
				keyValues,
				(acc: SplitConfigBackend, val, key) => {
					if (this.schema[key] == null || !this.schema[key].mutable) {
						throw new Error(
							`Config field ${key} not found or is immutable in config.set`,
						);
					}
					if (this.schema[key].source === 'config.json') {
						acc.configJsonVals[key] = val;
					} else if (this.schema[key].source === 'db') {
						acc.dbVals[key] = val;
					} else if (this.schema[key].source === 'func') {
						acc.fnVals[key] = val;
					} else {
						throw new Error(
							`Unknown config backend for key: ${key}, backend: ${
								this.schema[key].source
							}`,
						);
					}
					return acc;
				},
				{ configJsonVals: {}, dbVals: {}, fnVals: {} },
			);

			// Set these values, taking into account the knex transaction
			const setValuesInTransaction = (tx: Transaction): Bluebird<void> => {
				const dbKeys = _.keys(dbVals);
				return this.getMany(dbKeys, tx)
					.then(oldValues => {
						return Bluebird.map(dbKeys, (key: string) => {
							const value = dbVals[key];
							if (oldValues[key] !== value) {
								return this.db.upsertModel(
									'config',
									{ key, value },
									{ key },
									tx,
								);
							}
						});
					})
					.then(() => {
						return Bluebird.map(_.toPairs(fnVals), ([key, value]) => {
							const fn = this.providerFunctions[key];
							if (fn.set == null) {
								throw new Error(
									`Attempting to set provider function without set() method implemented - key: ${key}`,
								);
							}
							return fn.set(value, tx);
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
				return this.db
					.transaction(tx => {
						return setValuesInTransaction(tx);
					})
					.return();
			}
		})
			.then(() => {
				return setImmediate(() => {
					this.emit('change', keyValues);
				});
			})
			.return();
	}

	public remove(key: string): Bluebird<void> {
		return Bluebird.try(() => {
			if (this.schema[key] == null || !this.schema[key].mutable) {
				throw new Error(
					`Attempt to delete non-existent or immutable key ${key}`,
				);
			}
			if (this.schema[key].source === 'config.json') {
				return this.configJsonBackend.remove(key);
			} else if (this.schema[key].source === 'db') {
				return this.db
					.models('config')
					.del()
					.where({ key });
			} else if (this.schema[key].source === 'func') {
				const mutFn = this.providerFunctions[key];
				if (mutFn == null) {
					throw new Error(
						`Could not find provider function for config ${key}!`,
					);
				}
				if (mutFn.remove == null) {
					throw new Error(
						`Could not find removal provider function for config ${key}`,
					);
				}
				return mutFn.remove();
			} else {
				throw new Error(
					`Unknown or unsupported config backend: ${this.schema[key].source}`,
				);
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
			'offlineMode',
		]).then(({ uuid, deviceApiKey, apiSecret, offlineMode }) => {
			// These fields need to be set regardless
			if (uuid == null || apiSecret == null) {
				uuid = uuid || this.newUniqueKey();
				apiSecret = apiSecret || this.newUniqueKey();
			}
			return this.set({ uuid, apiSecret }).then(() => {
				if (offlineMode) {
					return;
				}
				if (!deviceApiKey) {
					return this.set({ deviceApiKey: this.newUniqueKey() });
				}
			});
		});
	}
}

export = Config;
