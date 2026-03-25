/**
 * This module contains the functionality for locking & unlocking resources
 * within the Supervisor Node process, useful for methods that need to acquire
 * exclusive access to a resource across multiple ticks in the event loop, async
 * functions for example.
 *
 * It is different from lockfile and update-lock modules, which handle
 * inter-container communication via lockfiles.
 *
 * TODO: Replace rwlock + Bluebird with async-mutex and native Promises.
 * This would also remove Bluebird from all callers that only import it
 * for the .using/.disposer pattern (configJson, poll, target-state, etc).
 */

import Lock from 'rwlock';

const locker = new Lock();

const takeGlobalLockRW = (key: string) =>
	new Promise<Lock.Release>((resolve, reject) => {
		locker.async.writeLock(key, (err, release) => {
			if (err) {
				reject(err);
			} else {
				resolve(release);
			}
		});
	});

const takeGlobalLockRO = (key: string) =>
	new Promise<Lock.Release>((resolve, reject) => {
		locker.async.readLock(key, (err, release) => {
			if (err) {
				reject(err);
			} else {
				resolve(release);
			}
		});
	});

export const takeGlobalLockRWDisposer = async (key: string) => {
	return {
		[Symbol.dispose]: await takeGlobalLockRW(key),
	};
};

export const takeGlobalLockRODisposer = async (key: string) => {
	return {
		[Symbol.dispose]: await takeGlobalLockRO(key),
	};
};
