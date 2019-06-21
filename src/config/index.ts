import * as Bluebird from 'bluebird';
import { EventEmitter } from 'events';
import { Transaction } from 'knex';
import * as _ from 'lodash';
import { generateUniqueKey } from 'resin-register-device';
import StrictEventEmitter from 'strict-event-emitter-types';
import { inspect } from 'util';

import { Either } from 'fp-ts/lib/Either';
import * as t from 'io-ts';

import ConfigJsonConfigBackend from './configJson';

import * as FnSchema from './functions';
import * as Schema from './schema';
import { SchemaReturn, SchemaTypeKey, schemaTypes } from './schema-type';

import DB from '../db';
import {
	ConfigurationValidationError,
	InternalInconsistencyError,
} from '../lib/errors';

interface ConfigOpts {
	db: DB;
	configPath?: string;
}

type ConfigMap<T extends SchemaTypeKey> = { [key in T]: SchemaReturn<key> };
type ConfigChangeMap<T extends SchemaTypeKey> = {
	[key in T]?: SchemaReturn<key>
};

// Export this type renamed, for storing config keys
export type ConfigKey = SchemaTypeKey;
export type ConfigType<T extends ConfigKey> = SchemaReturn<T>;

interface ConfigEvents {
	change: ConfigChangeMap<SchemaTypeKey>;
}

type ConfigEventEmitter = StrictEventEmitter<EventEmitter, ConfigEvents>;

export class Config extends (EventEmitter as new () => ConfigEventEmitter) {
	private db: DB;
	private configJsonBackend: ConfigJsonConfigBackend;

	public constructor({ db, configPath }: ConfigOpts) {
		super();
		this.db = db;
		this.configJsonBackend = new ConfigJsonConfigBackend(
			Schema.schema,
			configPath,
		);
	}

	public init(): Bluebird<void> {
		return this.configJsonBackend.init().then(() => {
			return this.generateRequiredFields();
		});
	}

	public get<T extends SchemaTypeKey>(
		key: T,
		trx?: Transaction,
	): Bluebird<SchemaReturn<T>> {
		const db = trx || this.db.models.bind(this.db);

		return Bluebird.try(() => {
			if (Schema.schema.hasOwnProperty(key)) {
				const schemaKey = key as Schema.SchemaKey;

				return this.getSchema(schemaKey, db).then(value => {
					if (value == null) {
						const defaultValue = schemaTypes[key].default;
						if (defaultValue instanceof t.Type) {
							// The only reason that this would be the case in a non-function
							// schema key is for the meta nullOrUndefined value. We check this
							// by first decoding the value undefined with the default type, and
							// then return undefined
							const maybeDecoded = (defaultValue as t.Type<any>).decode(
								undefined,
							);

							this.checkValueDecode(maybeDecoded, key, undefined);
							return maybeDecoded.value;
						}
						return defaultValue as SchemaReturn<T>;
					}
					const decoded = this.decodeSchema(schemaKey, value);

					this.checkValueDecode(decoded, key, value);

					return decoded.value;
				});
			} else if (FnSchema.fnSchema.hasOwnProperty(key)) {
				const fnKey = key as FnSchema.FnSchemaKey;
				// Cast the promise as something that produces an unknown, and this means that
				// we can validate the output of the function as well, ensuring that the type matches
				const promiseValue = FnSchema.fnSchema[fnKey](this) as Bluebird<
					unknown
				>;
				return promiseValue.then((value: unknown) => {
					const decoded = schemaTypes[key].type.decode(value);

					this.checkValueDecode(decoded, key, value);

					return decoded.value as SchemaReturn<T>;
				});
			} else {
				throw new Error(`Unknown config value ${key}`);
			}
		});
	}

	public getMany<T extends SchemaTypeKey>(
		keys: T[],
		trx?: Transaction,
	): Bluebird<{ [key in T]: SchemaReturn<key> }> {
		return Bluebird.map(keys, (key: T) => this.get(key, trx)).then(values => {
			return _.zipObject(keys, values);
		}) as Bluebird<{ [key in T]: SchemaReturn<key> }>;
	}

	public set<T extends SchemaTypeKey>(
		keyValues: ConfigMap<T>,
		trx?: Transaction,
	): Bluebird<void> {
		const setValuesInTransaction = (tx: Transaction) => {
			const configJsonVals: Dictionary<unknown> = {};
			const dbVals: Dictionary<unknown> = {};

			_.each(keyValues, (v, k: T) => {
				const schemaKey = k as Schema.SchemaKey;
				const source = Schema.schema[schemaKey].source;

				switch (source) {
					case 'config.json':
						configJsonVals[schemaKey] = v;
						break;
					case 'db':
						dbVals[schemaKey] = v;
						break;
					default:
						throw new Error(
							`Unknown configuration source: ${source} for config key: ${k}`,
						);
						break;
				}
			});

			const dbKeys = _.keys(dbVals) as T[];
			return this.getMany(dbKeys, tx)
				.then(oldValues => {
					return Bluebird.map(dbKeys, (key: T) => {
						const value = dbVals[key];

						// if we have anything other than a string, it must be converted to
						// a string before being stored in the db
						const strValue = Config.valueToString(value);

						if (oldValues[key] !== value) {
							return this.db.upsertModel(
								'config',
								{ key, value: strValue },
								{ key },
								tx,
							);
						}
					});
				})
				.then(() => {
					if (!_.isEmpty(configJsonVals)) {
						return this.configJsonBackend.set(configJsonVals as {
							[key in Schema.SchemaKey]: unknown
						});
					}
				});
		};

		return Bluebird.try(() => {
			// Firstly validate and coerce all of the types as they are being set
			keyValues = this.validateConfigMap(keyValues);

			if (trx != null) {
				return setValuesInTransaction(trx).return();
			} else {
				return this.db
					.transaction((tx: Transaction) => setValuesInTransaction(tx))
					.return();
			}
		}).then(() => {
			this.emit('change', keyValues as ConfigMap<SchemaTypeKey>);
		});
	}

	public remove<T extends Schema.SchemaKey>(key: T): Bluebird<void> {
		return Bluebird.try(() => {
			if (Schema.schema[key] == null || !Schema.schema[key].mutable) {
				throw new Error(
					`Attempt to delete non-existent or immutable key ${key}`,
				);
			}
			if (Schema.schema[key].source === 'config.json') {
				return this.configJsonBackend.remove(key);
			} else if (Schema.schema[key].source === 'db') {
				return this.db
					.models('config')
					.del()
					.where({ key });
			} else {
				throw new Error(
					`Unknown or unsupported config backend: ${Schema.schema[key].source}`,
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

	public newUniqueKey(): string {
		return generateUniqueKey();
	}

	public valueIsValid<T extends SchemaTypeKey>(
		key: T,
		value: unknown,
	): boolean {
		// If the default entry in the schema is a type and not a value,
		// use this in the validation of the value
		const schemaTypesEntry = schemaTypes[key as SchemaTypeKey];
		let type: t.Type<unknown>;
		if (schemaTypesEntry.default instanceof t.Type) {
			type = t.union([schemaTypesEntry.type, schemaTypesEntry.default]);
		} else {
			type = schemaTypesEntry.type;
		}

		return type.decode(value).isRight();
	}

	private async getSchema<T extends Schema.SchemaKey>(
		key: T,
		db: Transaction,
	): Promise<unknown> {
		let value: unknown;
		switch (Schema.schema[key].source) {
			case 'config.json':
				value = await this.configJsonBackend.get(key);
				break;
			case 'db':
				const [conf] = await db('config')
					.select('value')
					.where({ key });
				if (conf != null) {
					return conf.value;
				}
				break;
		}

		return value;
	}

	private decodeSchema<T extends Schema.SchemaKey>(
		key: T,
		value: unknown,
	): Either<t.Errors, SchemaReturn<T>> {
		return schemaTypes[key].type.decode(value);
	}

	private validateConfigMap<T extends SchemaTypeKey>(
		configMap: ConfigMap<T>,
	): ConfigMap<T> {
		// Just loop over every value, run the decode function, and
		// throw if any value fails verification
		return _.mapValues(configMap, (value, key) => {
			if (
				!Schema.schema.hasOwnProperty(key) ||
				!Schema.schema[key as Schema.SchemaKey].mutable
			) {
				throw new Error(
					`Attempt to set value for non-mutable schema key: ${key}`,
				);
			}

			// If the default entry in the schema is a type and not a value,
			// use this in the validation of the value
			const schemaTypesEntry = schemaTypes[key as SchemaTypeKey];
			let type: t.Type<unknown>;
			if (schemaTypesEntry.default instanceof t.Type) {
				type = t.union([schemaTypesEntry.type, schemaTypesEntry.default]);
			} else {
				type = schemaTypesEntry.type;
			}

			const decoded = type.decode(value);
			if (decoded.isLeft()) {
				throw new TypeError(
					`Cannot set value for ${key}, as value failed validation: ${inspect(
						value,
						{ depth: Infinity },
					)}`,
				);
			}
			return decoded.value;
		}) as ConfigMap<T>;
	}

	private generateRequiredFields() {
		return this.getMany([
			'uuid',
			'deviceApiKey',
			'apiSecret',
			'unmanaged',
		]).then(({ uuid, deviceApiKey, apiSecret, unmanaged }) => {
			// These fields need to be set regardless
			if (uuid == null || apiSecret == null) {
				uuid = uuid || this.newUniqueKey();
				apiSecret = apiSecret || this.newUniqueKey();
			}
			return this.set({ uuid, apiSecret }).then(() => {
				if (unmanaged) {
					return;
				}
				if (!deviceApiKey) {
					return this.set({ deviceApiKey: this.newUniqueKey() });
				}
			});
		});
	}

	private static valueToString(value: unknown) {
		switch (typeof value) {
			case 'object':
				return JSON.stringify(value);
			case 'number':
			case 'string':
			case 'boolean':
				return value.toString();
			default:
				throw new InternalInconsistencyError(
					`Could not convert configuration value to string for storage, value: ${value}, type: ${typeof value}`,
				);
		}
	}

	private checkValueDecode(
		decoded: Either<t.Errors, unknown>,
		key: string,
		value: unknown,
	): void {
		if (decoded.isLeft()) {
			throw new ConfigurationValidationError(key, value);
		}
	}
}

export default Config;
