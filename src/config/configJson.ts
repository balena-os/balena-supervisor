import _ from 'lodash';

import * as constants from '../lib/constants';
import * as hostUtils from '../lib/host-utils';
import {
	takeGlobalLockRODisposer,
	takeGlobalLockRWDisposer,
} from '../lib/process-lock';
import type * as Schema from './schema';

export default class ConfigJsonConfigBackend {
	private readonly readLockConfigJson = () =>
		takeGlobalLockRODisposer('config.json');
	private readonly writeLockConfigJson = () =>
		takeGlobalLockRWDisposer('config.json');

	private readonly schema: Schema.Schema;
	/**
	 * @deprecated configPath is only set by legacy tests
	 */
	private readonly configPath?: string;

	private cache: { [key: string]: unknown } = {};

	private readonly init = _.once(async () => {
		Object.assign(this.cache, await this.read());
	});

	public constructor(schema: Schema.Schema, configPath?: string) {
		this.schema = schema;
		this.configPath = configPath;
	}

	public async set<T extends Schema.SchemaKey>(keyVals: {
		[key in T]: unknown;
	}) {
		await this.init();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars -- it's used for resource management..
		using _lock = await this.writeLockConfigJson();
		let changed = false;
		_.forOwn(keyVals, (value, key: T) => {
			if (this.schema[key] != null && !_.isEqual(this.cache[key], value)) {
				this.cache[key] = value;

				if (value == null && this.schema[key].removeIfNull) {
					delete this.cache[key];
				}

				changed = true;
			}
		});
		if (changed) {
			await this.write();
		}
	}

	public async get(key: Schema.SchemaKey): Promise<unknown> {
		await this.init();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars -- it's used for resource management..
		using _lock = await this.readLockConfigJson();
		return await structuredClone(this.cache[key]);
	}

	public async remove(key: Schema.SchemaKey) {
		await this.init();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars -- it's used for resource management..
		using _lock = await this.writeLockConfigJson();
		let changed = false;

		if (this.cache[key] != null) {
			delete this.cache[key];
			changed = true;
		}

		if (changed) {
			await this.write();
		}
	}

	private async write(): Promise<void> {
		// writeToBoot uses fatrw to safely write to the boot partition
		await hostUtils.writeToBoot(this.path(), JSON.stringify(this.cache));
	}

	private async read(): Promise<string> {
		const filename = this.path();
		return JSON.parse(await hostUtils.readFromBoot(filename, 'utf-8'));
	}

	/**
	 * @deprecated Either read the config.json path from lib/constants, or
	 * pass a validated path to the constructor and fail if no path is passed.
	 * TODO: Remove this once api-binder tests are migrated. The only
	 * time configPath is passed to the constructor is in the legacy tests.
	 */
	private path(): string {
		// TODO: Remove this once api-binder tests are migrated. The only
		// time configPath is passed to the constructor is in the legacy tests.
		return this.configPath ?? constants.configJsonPath;
	}
}
