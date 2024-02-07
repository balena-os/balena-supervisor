import Bluebird from 'bluebird';
import _ from 'lodash';

import * as constants from '../lib/constants';
import * as hostUtils from '../lib/host-utils';
import * as osRelease from '../lib/os-release';
import { takeGlobalLockRO, takeGlobalLockRW } from '../lib/process-lock';
import type * as Schema from './schema';

export default class ConfigJsonConfigBackend {
	private readonly readLockConfigJson: () => Bluebird.Disposer<() => void>;
	private readonly writeLockConfigJson: () => Bluebird.Disposer<() => void>;

	private readonly schema: Schema.Schema;
	private readonly configPath?: string;

	private cache: { [key: string]: unknown } = {};

	private readonly init = _.once(async () =>
		Object.assign(this.cache, await this.read()),
	);

	public constructor(schema: Schema.Schema, configPath?: string) {
		this.configPath = configPath;
		this.schema = schema;

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
				if (this.cache[key] !== value) {
					this.cache[key] = value;

					if (
						value == null &&
						this.schema[key] != null &&
						this.schema[key].removeIfNull
					) {
						delete this.cache[key];
					}

					changed = true;
				}
			});
			if (changed) {
				await this.write();
			}
		});
	}

	public async get(key: string): Promise<unknown> {
		await this.init();
		return Bluebird.using(
			this.readLockConfigJson(),
			async () => this.cache[key],
		);
	}

	public async remove(key: string) {
		await this.init();
		return Bluebird.using(this.writeLockConfigJson(), async () => {
			let changed = false;

			if (this.cache[key] != null) {
				delete this.cache[key];
				changed = true;
			}

			if (changed) {
				await this.write();
			}
		});
	}

	private async write(): Promise<void> {
		// writeToBoot uses fatrw to safely write to the boot partition
		return hostUtils.writeToBoot(await this.path(), JSON.stringify(this.cache));
	}

	private async read(): Promise<string> {
		const filename = await this.path();
		return JSON.parse(await hostUtils.readFromBoot(filename, 'utf-8'));
	}

	private async path(): Promise<string> {
		// TODO: Remove this once api-binder tests are migrated. The only
		// time configPath is passed to the constructor is in the legacy tests.
		if (this.configPath != null) {
			return this.configPath;
		}

		const osVersion = await osRelease.getOSVersion(constants.hostOSVersionPath);
		if (osVersion == null) {
			throw new Error('Failed to detect OS version!');
		}

		// The default path in the boot partition
		return constants.configJsonPath;
	}
}
