import * as Bluebird from 'bluebird';
import * as lockFileLib from 'lockfile';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import * as Lock from 'rwlock';

import constants = require('./constants');
import { ENOENT, UpdatesLockedError } from './errors';

type asyncLockFile = typeof lockFileLib & {
	unlockAsync(path: string): Bluebird<void>;
	lockAsync(path: string): Bluebird<void>;
};
const lockFile = Bluebird.promisifyAll(lockFileLib) as asyncLockFile;
export type LockCallback = (
	appId: number,
	opts: { force: boolean },
	fn: () => PromiseLike<void>,
) => Bluebird<void>;

function baseLockPath(appId: number): string {
	return path.join('/tmp/balena-supervisor/services', appId.toString());
}

export function lockPath(appId: number, serviceName: string): string {
	return path.join(baseLockPath(appId), serviceName);
}

function lockFilesOnHost(appId: number, serviceName: string): string[] {
	return ['updates.lock', 'resin-updates.lock'].map(filename =>
		path.join(constants.rootMountPoint, lockPath(appId, serviceName), filename),
	);
}

const locksTaken: { [lockName: string]: boolean } = {};
const existingLocks: { [lockName: string]: number } = {};

// Try to clean up any existing locks when the program exits
process.on('exit', () => {
	for (const lockName of _.keys(locksTaken)) {
		try {
			lockFile.unlockSync(lockName);
		} catch (e) {
			// Ignore unlocking errors
		}
	}
});

type LockFn = (key: string | number) => Bluebird<() => void>;
const locker = new Lock();
export const writeLock: LockFn = Bluebird.promisify(locker.async.writeLock, {
	context: locker,
});
export const readLock: LockFn = Bluebird.promisify(locker.async.readLock, {
	context: locker,
});

function dispose(release: () => void): Bluebird<void> {
	return Bluebird.map(_.keys(locksTaken), lockName => {
		delete locksTaken[lockName];
		return lockFile.unlockAsync(lockName);
	})
		.finally(release)
		.return();
}

export function lock(
	appId: number | null,
	{
		force = false,
		keepLocks = false,
		lockKeepTimeout = 300000,
	}: { force: boolean; keepLocks: boolean; lockKeepTimeout: number },
	fn: () => PromiseLike<void>,
): Bluebird<void> {
	const takeTheLock = () => {
		if (appId == null) {
			return;
		}
		return writeLock(appId)
			.tap((release: () => void) => {
				const lockDir = path.join(
					constants.rootMountPoint,
					baseLockPath(appId),
				);

				return Bluebird.resolve(fs.readdir(lockDir))
					.catchReturn(ENOENT, [])
					.mapSeries(serviceName => {
						return Bluebird.mapSeries(
							lockFilesOnHost(appId, serviceName),
							tmpLockName => {
								return Bluebird.try(() => {
									if (force) {
										// Save locks that existed before force unlocking them if keepLocks is set
										if (lockFile.checkSync(tmpLockName) && keepLocks) {
											existingLocks[tmpLockName] = Date.now();
										}

										return lockFile.unlockAsync(tmpLockName);
									} else {
										// Enforce virtual locks, when keepLocks was set previously
										// This prevents targetState updates for lockKeepTimeout after the
										// function using keepLocks was active.
										// A concrete example would be the purge, which could lead to also
										// apply a appUpdate after the purge completed leading to non-
										// deterministic behavior.
										if (_.keys(existingLocks).indexOf(tmpLockName) !== -1) {
											if (
												existingLocks[tmpLockName] + lockKeepTimeout <
												Date.now()
											) {
												delete existingLocks[tmpLockName];
											} else {
												throw new Error(
													'Lock was set previously and is enforced by lock keep timeout',
												);
											}
										}
									}
								})
									.then(() => lockFile.lockAsync(tmpLockName))
									.then(() => {
										locksTaken[tmpLockName] = true;
									})
									.catchReturn(ENOENT, undefined);
							},
						).catch(err => {
							return dispose(release).throw(
								new UpdatesLockedError(`Updates are locked: ${err.message}`),
							);
						});
					});
			})
			.disposer(dispose);
	};

	const disposer = takeTheLock();
	if (disposer) {
		return Bluebird.using(disposer, fn);
	} else {
		return Bluebird.resolve(fn());
	}
}
