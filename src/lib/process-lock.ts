/**
 * This module contains the functionality for locking & unlocking resources
 * within the Supervisor Node process, useful for methods that need to acquire
 * exclusive access to a resource across multiple ticks in the event loop, async
 * functions for example.
 *
 * It is different from lockfile and update-lock modules, which handle
 * inter-container communication via lockfiles.
 *
 * TODO:
 * - Use a maintained solution such as async-lock
 * - Move to native Promises
 */

import Bluebird from 'bluebird';
import Lock from 'rwlock';
import type { Release } from 'rwlock';

type LockFn = (key: string | number) => Bluebird<Release>;

const locker = new Lock();

export const takeGlobalLockRW: LockFn = Bluebird.promisify(
	locker.async.writeLock,
	{
		context: locker,
	},
);

export const takeGlobalLockRO: LockFn = Bluebird.promisify(
	locker.async.readLock,
	{
		context: locker,
	},
);
