import Bluebird from 'bluebird';
import _ from 'lodash';
import { isRight } from 'fp-ts/lib/Either';

import * as constants from '../lib/constants';
import * as hostUtils from '../lib/host-utils';
import * as osRelease from '../lib/os-release';
import { takeGlobalLockRO, takeGlobalLockRW } from '../lib/process-lock';
import log from '../lib/supervisor-console';
import type * as Schema from './schema';
import { schemaTypes } from './schema-type';
import type { SchemaReturn } from './schema-type';

// Returns true if v is a non-null, non-array object
const isObject = (v: unknown): v is { [key: string]: unknown } =>
	!!v && _.isObject(v) && !Array.isArray(v);

export default class ConfigJsonConfigBackend {
	private readonly readLockConfigJson: () => Bluebird.Disposer<() => void>;
	private readonly writeLockConfigJson: () => Bluebird.Disposer<() => void>;

	private readonly schema: Schema.Schema;
	private readonly protectedFields: Schema.ProtectedFields;
	/**
	 * @deprecated configPath is only set by legacy tests
	 */
	private readonly configPath?: string;

	private cache: { [key: string]: unknown } = {};

	private readonly init = _.once(async () => {
		if ((await osRelease.getOSVersion(constants.hostOSVersionPath)) == null) {
			throw new Error('Failed to detect OS version!');
		}
		Object.assign(this.cache, await this.read());
	});

	public constructor(
		schema: Schema.Schema,
		protectedFields: Schema.ProtectedFields,
		configPath?: string,
	) {
		this.schema = schema;
		this.protectedFields = protectedFields;
		this.configPath = configPath;

		this.writeLockConfigJson = () =>
			takeGlobalLockRW('config.json').disposer((release) => release());
		this.readLockConfigJson = () =>
			takeGlobalLockRO('config.json').disposer((release) => release());
	}

	public async set<T extends Schema.SchemaKey>(keyVals: {
		[key in T]: unknown;
	}) {
		await this.init();
		await Bluebird.using(this.writeLockConfigJson(), async () => {
			let changed = false;
			_.forOwn(keyVals, (value, key: T) => {
				// Handle protected fields (object fields only partially managed by Supervisor)
				if (this.isProtectedField(key)) {
					const k = key as Schema.ProtectedFieldsMember;
					changed = this.handleProtectedField(k, value) || changed;
				} else if (
					this.schema[key] != null &&
					!_.isEqual(this.cache[key], value)
				) {
					// Handle normal fields (fields fully managed by Supervisor)
					const k = key as Schema.SchemaKey;
					this.cache[k] = value;

					if (
						value == null &&
						this.schema[k] != null &&
						this.schema[k].removeIfNull
					) {
						delete this.cache[k];
					}

					changed = true;
				}
			});
			if (changed) {
				await this.write();
			}
		});
	}

	public async get(key: Schema.SchemaKey): Promise<unknown> {
		await this.init();
		return Bluebird.using(this.readLockConfigJson(), async () => {
			// If protected field, return only managed fields,
			// decoding using t.strict / t.exact to filter out unmanaged fields
			if (this.isProtectedField(key)) {
				const k = key as Schema.ProtectedFieldsMember;
				const decoded = schemaTypes[k].type.decode(this.cache[k]);
				if (isRight(decoded)) {
					// Remove empty objects
					// i.e. { power: { mode: 'high' }, fan: {} } -> { power: { mode: 'high' } }
					return _.omitBy(decoded.right, _.isEmpty);
				} else {
					return {};
				}
			} else {
				return this.cache[key];
			}
		});
	}

	public async remove(key: string) {
		await this.init();
		return Bluebird.using(this.writeLockConfigJson(), async () => {
			let changed = false;

			if (this.isProtectedField(key)) {
				const k = key as Schema.ProtectedFieldsMember;
				changed = this.handleProtectedField(k, {}) || changed;
			} else if (this.cache[key] != null) {
				delete this.cache[key];
				changed = true;
			}

			if (changed) {
				await this.write();
			}
		});
	}

	private isProtectedField(key: string): boolean {
		return this.protectedFields.includes(key as Schema.ProtectedFieldsMember);
	}

	/**
	 * Handle config.json object fields that are partially managed by Supervisor.
	 * Unmanaged fields should not be changed.
	 *
	 * @param key Protected field key
	 * @param target Target value for protected field
	 * @returns boolean indicating whether managed values in protected field were updated
	 */
	private handleProtectedField<T extends Schema.ProtectedFieldsMember>(
		key: T,
		target: unknown,
	): boolean {
		const { type } = schemaTypes[key];

		// Get current managed values of protected field
		let cur: SchemaReturn<Schema.ProtectedFieldsMember>;
		if (this.cache[key] == null) {
			// Current value not defined
			cur = {};
		} else {
			// Decoding should filter out unmanaged fields using t.strict / t.exact.
			const maybeWriteableCurrent = type.decode(this.cache[key]);
			if (!isRight(maybeWriteableCurrent)) {
				log.error(
					`Failed to decode current value for protected field ${key} in config.json`,
				);
				return false;
			}
			// Decoded right is a reference to the cache object, so we need to clone it as
			// we don't want to modify the cache object until the very end of this function.
			cur = structuredClone(maybeWriteableCurrent.right);
		}

		const maybeTarget = type.decode(target);
		if (!isRight(maybeTarget)) {
			log.error(
				`Failed to decode target value for protected field ${key}: ${target}`,
			);
			return false;
		}
		const tgt = maybeTarget.right;

		// For any fields in current but not target, mark them for deletion in target
		// by setting to `null` so that they are evaluated when merging, as _.mergeWith
		// only iterates over keys present in both current and target objects
		for (const k of Object.keys(cur) as Array<keyof typeof cur>) {
			if (!(k in tgt)) {
				tgt[k] = null as any;
			}
		}

		// Merge target into current for managed fields only
		const mergeStrategy = <
			V extends SchemaReturn<Schema.ProtectedFieldsMember>,
		>(
			curVal: V,
			tgtVal: V,
		): { [K in keyof V]: V[K] | null } => {
			const curIsObj = isObject(curVal);
			const tgtIsObj = isObject(tgtVal);
			// If current is object but target is null, set all managed values
			// in current to null to mark them for deletion
			if (curIsObj && tgtVal == null) {
				return _.mapValues(curVal, () => null);
			} else if (curVal == null && tgtIsObj) {
				// If current is null but target is object, return target
				return tgtVal;
			} else if (curIsObj && tgtIsObj) {
				// If both are objects, recursively merge them
				return _.mergeWith(curVal, tgtVal, mergeStrategy);
			} else {
				// Both are defined but not objects, so return target
				return tgtVal;
			}
		};

		const mergedManagedFields = _.mergeWith(cur, tgt, mergeStrategy);

		// Merge managed resulting fields into the rest of the cached object value
		const mergeManagedIntoRest = <O extends { [key: string]: unknown }>(
			rest: unknown,
			managed: O,
		): O => {
			if (!isObject(rest)) {
				return managed;
			} else {
				for (const k of Object.keys(managed)) {
					// If managed value is null, delete rest
					if (managed[k] === null && rest[k] != null) {
						delete rest[k];
					} else if (isObject(rest[k]) && isObject(managed[k])) {
						// If both are objects, recursively merge them
						mergeManagedIntoRest(rest[k], managed[k]);
					} else {
						// Otherwise, update field in cached object
						rest[k] = managed[k];
					}
				}
				return rest as O;
			}
		};

		const currentCache = structuredClone(this.cache[key]);
		const updatedCache = mergeManagedIntoRest(
			currentCache,
			mergedManagedFields,
		);
		if (!_.isEqual(this.cache[key], updatedCache)) {
			this.cache[key] = updatedCache;
			return true;
		} else {
			return false;
		}
	}

	private async write(): Promise<void> {
		// writeToBoot uses fatrw to safely write to the boot partition
		return hostUtils.writeToBoot(await this.path(), JSON.stringify(this.cache));
	}

	private async read(): Promise<string> {
		const filename = await this.path();
		return JSON.parse(await hostUtils.readFromBoot(filename, 'utf-8'));
	}

	/**
	 * @deprecated Either read the config.json path from lib/constants, or
	 * pass a validated path to the constructor and fail if no path is passed.
	 * TODO: Remove this once api-binder tests are migrated. The only
	 * time configPath is passed to the constructor is in the legacy tests.
	 */
	private async path(): Promise<string> {
		// TODO: Remove this once api-binder tests are migrated. The only
		// time configPath is passed to the constructor is in the legacy tests.
		if (this.configPath != null) {
			return this.configPath;
		}

		// The default path in the boot partition
		return constants.configJsonPath;
	}
}
