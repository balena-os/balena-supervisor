import { EventEmitter } from 'events';
import type { Knex } from 'knex';
import _ from 'lodash';
import type StrictEventEmitter from 'strict-event-emitter-types';
import { inspect } from 'util';
import { generateUniqueKey } from '../lib/register-device';

import type { Either, Right } from 'fp-ts/lib/Either';
import { isLeft, isRight } from 'fp-ts/lib/Either';
import * as t from 'io-ts';

import ConfigJsonConfigBackend from './configJson';

import * as FnSchema from './functions';
import * as Schema from './schema';
import type { SchemaReturn, SchemaTypeKey } from './schema-type';
import { schemaTypes } from './schema-type';

import * as db from '../db';
import {
	ConfigurationValidationError,
	InternalInconsistencyError,
} from '../lib/errors';

export type ConfigMap<T extends SchemaTypeKey> = {
	[key in T]: SchemaReturn<key>;
};
export type ConfigChangeMap<T extends SchemaTypeKey> = {
	[key in T]?: SchemaReturn<key>;
};

// Export this type renamed, for storing config keys
export type ConfigKey = SchemaTypeKey;
export type ConfigType<T extends ConfigKey> = SchemaReturn<T>;

interface ConfigEventTypes {
	change: ConfigChangeMap<SchemaTypeKey>;
}

export const configJsonBackend: ConfigJsonConfigBackend =
	new ConfigJsonConfigBackend(Schema.schema);

type ConfigEventEmitter = StrictEventEmitter<EventEmitter, ConfigEventTypes>;
class ConfigEvents extends (EventEmitter as new () => ConfigEventEmitter) {}
const events = new ConfigEvents();

// Expose methods which make this module act as an EventEmitter
export const on: (typeof events)['on'] = events.on.bind(events);
export const once: (typeof events)['once'] = events.once.bind(events);
export const removeListener: (typeof events)['removeListener'] =
	events.removeListener.bind(events);

export async function get<T extends SchemaTypeKey>(
	key: T,
	trx?: Knex.Transaction,
): Promise<SchemaReturn<T>> {
	const $db = trx || db.models;

	if (Object.hasOwn(Schema.schema, key)) {
		const schemaKey = key as Schema.SchemaKey;

		return getSchema(schemaKey, $db).then((value) => {
			if (value == null) {
				const defaultValue = schemaTypes[key].default;
				if (defaultValue instanceof t.Type) {
					// The only reason that this would be the case in a non-function
					// schema key is for the meta nullOrUndefined value. We check this
					// by first decoding the value undefined with the default type, and
					// then return undefined
					const maybeDecoded = (defaultValue as t.Type<any>).decode(undefined);

					return (
						checkValueDecode(maybeDecoded, key, undefined) && maybeDecoded.right
					);
				}
				return defaultValue as SchemaReturn<T>;
			}
			const decoded = decodeSchema(schemaKey, value);

			// The following function will throw if the value
			// is not correct, so we chain it this way to keep
			// the type system happy
			return checkValueDecode(decoded, key, value) && decoded.right;
		});
	} else if (Object.hasOwn(FnSchema.fnSchema, key)) {
		const fnKey = key as FnSchema.FnSchemaKey;
		// Cast the promise as something that produces an unknown, and this means that
		// we can validate the output of the function as well, ensuring that the type matches
		const promiseValue = FnSchema.fnSchema[fnKey]();
		return promiseValue
			.then((value: unknown) => {
				const decoded = schemaTypes[key].type.decode(value);

				return checkValueDecode(decoded, key, value) && decoded.right;
			})
			.catch(() => {
				const defaultValue = schemaTypes[key].default;
				if (defaultValue instanceof t.Type) {
					// For functions, this can happen if t.never is used as default
					// value. In that case decoding and the value check below will throw
					// (which is what is expected)
					// if future functions use NullOrUndefined as with values above
					// this branch will return undefined. In any case this should never
					// happen
					const maybeDecoded = (defaultValue as t.Type<any>).decode(undefined);

					return (
						checkValueDecode(maybeDecoded, key, undefined) && maybeDecoded.right
					);
				}
				return defaultValue as SchemaReturn<T>;
			});
	} else {
		throw new Error(`Unknown config value ${key}`);
	}
}

export async function getMany<T extends SchemaTypeKey>(
	keys: T[],
	trx?: Knex.Transaction,
): Promise<{ [key in T]: SchemaReturn<key> }> {
	const values = await Promise.all(keys.map((k) => get(k, trx)));
	return _.zipObject(keys, values) as unknown as Promise<{
		[key in T]: SchemaReturn<key>;
	}>;
}

export async function set<T extends SchemaTypeKey>(
	keyValues: ConfigMap<T>,
	trx?: Knex.Transaction,
): Promise<void> {
	const setValuesInTransaction = async (tx: Knex.Transaction) => {
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
			}
		});

		const dbKeys = _.keys(dbVals) as T[];
		const oldValues = await getMany(dbKeys, tx);
		await Promise.all(
			dbKeys.map(async (key: T) => {
				const value = dbVals[key];

				// if we have anything other than a string, it must be converted to
				// a string before being stored in the db
				const strValue = valueToString(value, key);

				if (oldValues[key] !== value) {
					await db.upsertModel('config', { key, value: strValue }, { key }, tx);
				}
			}),
		);

		if (!_.isEmpty(configJsonVals)) {
			await configJsonBackend.set(
				configJsonVals as {
					[name in Schema.SchemaKey]: unknown;
				},
			);
		}
	};

	// Firstly validate and coerce all of the types as
	// they are being set
	keyValues = validateConfigMap(keyValues);

	if (trx != null) {
		await setValuesInTransaction(trx);
	} else {
		await db.transaction((tx) => setValuesInTransaction(tx));
	}
	events.emit('change', keyValues as ConfigMap<SchemaTypeKey>);
}

export async function remove<T extends Schema.SchemaKey>(
	key: T,
): Promise<void> {
	if (Schema.schema[key] == null || !Schema.schema[key].mutable) {
		throw new Error(`Attempt to delete non-existent or immutable key ${key}`);
	}
	if (Schema.schema[key].source === 'config.json') {
		return configJsonBackend.remove(key);
	} else if (Schema.schema[key].source === 'db') {
		await db.models('config').del().where({ key });
	} else {
		throw new Error(
			`Unknown or unsupported config backend: ${Schema.schema[key].source}`,
		);
	}
}

export async function regenerateRegistrationFields(): Promise<void> {
	await set({
		uuid: newUniqueKey(),
		deviceApiKey: newUniqueKey(),
	});
}

export function newUniqueKey(): string {
	return generateUniqueKey();
}

export function valueIsValid<T extends SchemaTypeKey>(
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

	return isRight(type.decode(value));
}

async function getSchema<T extends Schema.SchemaKey>(
	key: T,
	$db: typeof db.models,
): Promise<unknown> {
	let value: unknown;
	switch (Schema.schema[key].source) {
		case 'config.json':
			value = await configJsonBackend.get(key);
			break;
		case 'db':
			{
				const [conf] = await $db('config').select('value').where({ key });
				if (conf != null) {
					return conf.value;
				}
			}
			break;
	}

	return value;
}

function decodeSchema<T extends Schema.SchemaKey>(
	key: T,
	value: unknown,
): Either<t.Errors, SchemaReturn<T>> {
	return schemaTypes[key].type.decode(value);
}

function validateConfigMap<T extends SchemaTypeKey>(
	configMap: ConfigMap<T>,
): ConfigMap<T> {
	// Just loop over every value, run the decode function, and
	// throw if any value fails verification
	return _.mapValues(configMap, (value, key) => {
		if (
			!Object.hasOwn(Schema.schema, key) ||
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
		if (isLeft(decoded)) {
			throw new TypeError(
				`Cannot set value for ${key}, as value failed validation: ${inspect(
					value,
					{ depth: Infinity },
				)}`,
			);
		}
		return decoded.right;
	}) as ConfigMap<T>;
}

export async function generateRequiredFields() {
	return getMany(['uuid', 'deviceApiKey', 'unmanaged']).then(
		({ uuid, deviceApiKey, unmanaged }) => {
			// These fields need to be set regardless
			if (uuid == null) {
				uuid = uuid || newUniqueKey();
			}
			return set({ uuid }).then(() => {
				if (unmanaged) {
					return;
				}
				if (!deviceApiKey) {
					return set({ deviceApiKey: newUniqueKey() });
				}
			});
		},
	);
}

function valueToString(value: unknown, name: string) {
	switch (typeof value) {
		case 'object':
			return JSON.stringify(value);
		case 'number':
		case 'string':
		case 'boolean':
			return value.toString();
		default:
			throw new InternalInconsistencyError(
				`Could not convert configuration value to string for storage, name: ${name}, value: ${value}, type: ${typeof value}`,
			);
	}
}

function checkValueDecode<T>(
	decoded: Either<t.Errors, T>,
	key: string,
	value: T,
): decoded is Right<T> {
	if (isLeft(decoded)) {
		throw new ConfigurationValidationError(key, value);
	}
	return true;
}

export const initialized = _.once(async () => {
	await db.initialized();
	await generateRequiredFields();
});
