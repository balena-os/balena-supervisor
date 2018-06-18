import * as Promise from 'bluebird';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import * as Lock from 'rwlock';

import { ConfigSchema, ConfigValue } from '../lib/types';

import * as constants from '../lib/constants';
import { writeAndSyncFile, writeFileAtomic } from '../lib/fs-utils';
import * as osRelease from '../lib/os-release';

type LockCallback = (file: string) => Promise<() => void>;

export default class ConfigJsonConfigBackend {

	private lock: Lock;
	private readLockConfigJson: () => Promise.Disposer<() => void>;
	private writeLockConfigJson: () => Promise.Disposer<() => void>;

	private configPath?: string;
	private cache: { [key: string]: ConfigValue } = { };

	private schema: ConfigSchema;

	public constructor(schema: ConfigSchema, configPath?: string) {

		this.configPath = configPath;
		this.schema = schema;
		this.lock = new Lock();

		const writeLock: LockCallback = Promise.promisify(this.lock.async.writeLock);
		const readLock: LockCallback  = Promise.promisify(this.lock.async.readLock);
		this.writeLockConfigJson = () => writeLock('config.json').disposer((release) => release());
		this.readLockConfigJson = () => readLock('config.json').disposer((release) => release());
	}

	public init(): Promise<void> {
		return this.read()
			.then((configJson) => {
				_.assign(this.cache, configJson);
			});
	}

	public set(keyVals: { [key: string]: ConfigValue }): Promise<void> {
		let changed = false;
		return Promise.using(this.writeLockConfigJson(), () => {

			return Promise.mapSeries(_.keys(keyVals), (key: string) => {

				const value = keyVals[key];

				if (this.cache[key] !== value) {
					this.cache[key] = value;

					if (value == null && this.schema[key] != null && this.schema[key].removeIfNull) {
						delete this.cache[key];
					}

					changed = true;
				}
			})
				.then(() => {
					if (changed) {
						return this.write();
					}
				});
		});
	}

	public get(key: string): Promise<ConfigValue> {
		return Promise.using(this.readLockConfigJson(), () => {
			return Promise.resolve(this.cache[key]);
		});
	}

	public remove(key: string): Promise<void> {
		let changed = false;
		return Promise.using(this.writeLockConfigJson(), () => {
			if (this.cache[key] != null) {
				delete this.cache[key];
				changed = true;
			}

			if (changed) {
				this.write();
			}

			return Promise.resolve();
		});
	}

	public path(): Promise<string> {
		return this.pathOnHost()
			.catch((err) => {
				console.error(err.message);
				return constants.configJsonNonAtomicPath;
			});
	}

	private write(): Promise<void> {
		let atomicWritePossible = true;
		return this.pathOnHost()
			.catch((err) => {
				console.error(err.message);
				atomicWritePossible = false;
				return constants.configJsonNonAtomicPath;
			})
			.then((configPath) => {
				if (atomicWritePossible) {
					return writeFileAtomic(configPath, JSON.stringify(this.cache));
				} else {
					return writeAndSyncFile(configPath, JSON.stringify(this.cache));
				}
			});
	}

	private read(): Promise<string> {
		return this.path()
			.then((filename) => {
				return fs.readFile(filename, 'utf-8');
			})
			.then(JSON.parse);
	}
	private pathOnHost(): Promise<string> {
		return Promise.try(() => {
			if (this.configPath != null) {
				return this.configPath;
			}
			if (constants.configJsonPathOnHost != null) {
				return constants.configJsonPathOnHost;
			}
			return osRelease.getOSVersion(constants.hostOSVersionPath)
				.then((osVersion) => {

					if (osVersion == null) {
						throw new Error('Failed to detect OS version!');
					}
					if (/^Resin OS (1|2)./.test(osVersion)) {
						// In Resin OS 1.12, $BOOT_MOUNTPOINT was added and it coincides with config.json's path
						if (constants.bootMountPointFromEnv != null) {
							return path.join(constants.bootMountPointFromEnv, 'config.json');
						}
						// Older 1.X versions have config.json here
						return '/mnt/conf/config.json';
					} else {
						// In non-resinOS hosts (or older than 1.0.0), if CONFIG_JSON_PATH wasn't passed
						// then we can't do atomic changes (only access to config.json we have is in /boot,
						// which is assumed to be a file bind mount where rename is impossible)
						throw new Error('Could not determine config.json path on host, atomic write will not be possible');
					}
				});
		})
			.then((file) => {
				return path.join(constants.rootMountPoint, file);
			});
	}

}
