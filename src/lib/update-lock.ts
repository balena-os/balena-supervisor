import { promises as fs } from 'fs';
import path from 'path';
import { setTimeout } from 'timers/promises';
import type ReadWriteLock from 'rwlock';

import { isENOENT, UpdatesLockedError } from './errors';
import { pathOnRoot, pathExistsOnState } from './host-utils';
import { mkdirp } from './fs-utils';
import * as lockfile from './lockfile';
import { takeGlobalLockRW } from './process-lock';
import * as logTypes from './log-types';
import * as logger from '../logging';

export const LOCKFILE_UID = 65534;
export const BASE_LOCK_DIR = '/tmp/balena-supervisor/services';

export function lockPath(appId: string | number, serviceName?: string): string {
	return path.join(BASE_LOCK_DIR, appId.toString(), serviceName ?? '');
}

function lockFilesOnHost(
	appId: string | number,
	serviceName: string,
): string[] {
	return pathOnRoot(
		...['updates.lock', 'resin-updates.lock'].map((filename) =>
			path.join(lockPath(appId), serviceName, filename),
		),
	);
}

/**
 * Check for rollback-{health|altboot}-breadcrumb, two files that exist while
 * rollback-{health|altboot}.service have not exited. If these files exist,
 * prevent reboot. If the Supervisor reboots while those services are still running,
 * the device may become stuck in an invalid state during HUP.
 */
export async function abortIfHUPInProgress({
	force = false,
}: {
	force?: boolean;
}): Promise<boolean> {
	const breadcrumbs = await Promise.all(
		['rollback-health-breadcrumb', 'rollback-altboot-breadcrumb'].map(
			(filename) => pathExistsOnState(filename),
		),
	);

	const hasHUPBreadcrumb = breadcrumbs.some((e) => e);
	if (hasHUPBreadcrumb && !force) {
		throw new UpdatesLockedError('Waiting for Host OS update to finish');
	}

	return hasHUPBreadcrumb;
}

interface LockingOpts {
	/**
	 * Delete existing user locks if any
	 */
	force: boolean;

	/**
	 * If the locks are being held by another operation
	 * on the supervisor, this is the max time that the call
	 * will wait before throwing
	 */
	maxWaitMs: number;
}

async function takeGlobalLockOrFail(
	appId: string,
	maxWaitMs = 0, // 0 === wait forever
): Promise<ReadWriteLock.Release> {
	let abort = false;
	const lockingPromise = takeGlobalLockRW(appId).then((disposer) => {
		// Even if the timer resolves first, takeGlobalLockRW
		// will eventually resolve and in that case we need to call the disposer
		// to avoid a deadlock
		if (abort) {
			disposer();
			return () => {
				/* noop */
			};
		} else {
			return disposer;
		}
	});

	const promises: Array<Promise<ReadWriteLock.Release | string>> = [
		lockingPromise,
	];

	const ac = new AbortController();
	const signal = ac.signal;
	if (maxWaitMs > 0) {
		promises.push(setTimeout(maxWaitMs, 'abort', { signal }));
	}

	try {
		const res = await Promise.race(promises);
		if (res === 'abort') {
			abort = true;
			throw new UpdatesLockedError(
				`Locks for app ${appId} are being held by another supervisor operation`,
			);
		}
		return lockingPromise;
	} finally {
		// Clear the timeout
		ac.abort();
	}
}

export interface Lock {
	unlock(): Promise<void>;
}

export interface Lockable {
	lock(opts?: Partial<LockingOpts>): Promise<Lock>;
}

function newLockable(appId: string, services: string[]): Lockable {
	async function unlockApp(locks: string[], release: () => void) {
		try {
			logger.logSystemEvent(logTypes.releaseLock, { appId });
			await Promise.all(locks.map((l) => lockfile.unlock(l)));
		} finally {
			release();
		}
	}

	async function lockApp({
		force = false,
		maxWaitMs = 0,
	}: Partial<LockingOpts> = {}) {
		// Log before taking the global lock to detect
		// possible deadlocks
		logger.logSystemEvent(logTypes.takeLock, {
			appId,
			services,
			force,
		});

		// Try to take the global lock for the given appId
		// this ensures the user app locks are only taken in a single
		// place on the supervisor
		const release: ReadWriteLock.Release = await takeGlobalLockOrFail(
			appId,
			maxWaitMs,
		);

		// This keeps a list of all locks currently being
		// held by the lockable
		let currentLocks: string[] = [];

		try {
			// Find all the locks already taken for the appId
			// if this is not empty it probably means these locks are from
			// a previous run of the supervisor

			currentLocks = await leftoverLocks(appId);

			// Group locks by service
			const locksByService = services.map((service) => {
				const existing = currentLocks.filter((lockFile) =>
					lockFilesOnHost(appId, service).includes(lockFile),
				);
				return { service, existing };
			}, {});

			// Filter out services that already have Supervisor-taken locks.
			// This needs to be done after taking the appId write lock to avoid
			// race conditions with locking.
			const servicesWithMissingLocks = locksByService.filter(
				({ existing }) => existing.length < 2,
			);

			// For every service that has yet to be fully locked we need to
			// take the locks
			for (const { service, existing } of servicesWithMissingLocks) {
				// Create the directory if it doesn't exist
				await mkdirp(pathOnRoot(lockPath(appId, service)));

				// We will only take those locks that have not yet been taken by
				// the supervisor
				const missingLocks = lockFilesOnHost(appId, service).filter(
					(l) => !existing.includes(l),
				);

				for (const file of missingLocks) {
					try {
						if (force) {
							// If force: true we remove the lock first
							await lockfile.unlock(file);
						}
						await lockfile.lock(file, LOCKFILE_UID);

						// If locking was successful, we update the current locks
						// list
						currentLocks.push(file);
					} catch (e) {
						if (lockfile.LockfileExistsError.is(e)) {
							// Throw more descriptive error
							throw new UpdatesLockedError(
								`Lockfile exists for { appId: ${appId}, service: ${service} }`,
							);
						}
						// Otherwise just throw the error
						throw e;
					}
				}
			}

			return {
				unlock: async () => {
					await unlockApp(currentLocks, release);
				},
			};
		} catch (err) {
			// If any error happens while taking locks, we need to unlock
			// to avoid some locks being held by user apps and some by
			// the supervisor
			await unlockApp(currentLocks, release);

			// Re-throw error to be handled in caller
			throw err;
		}
	}

	return { lock: lockApp };
}

export const Lockable = {
	from(appId: string | number, services: string[]) {
		// Convert appId to string so we always
		// use the same value when taking the process lock
		return newLockable(appId.toString(), services);
	},
};

/**
 * Call the given function after locks for the given apps
 * have been taken.
 *
 * This is compatible with Lockable.lock() in the sense that only one locking
 * operation is allowed at the time on the supervisor
 *
 * By default the call will wait 10 seconds for shared process locks before
 * giving up
 */
export async function withLock<T>(
	appIds: number | number[],
	fn: () => Resolvable<T>,
	{ force = false, maxWaitMs = 10 * 1000 }: Partial<LockingOpts> = {},
): Promise<T> {
	appIds = Array.isArray(appIds) ? appIds : [appIds];
	if (appIds.length === 0) {
		return fn();
	}

	// Always lock in the same order
	appIds = appIds.sort();

	const locks: Lock[] = [];
	try {
		const lockables: Lockable[] = [];
		for (const appId of appIds) {
			const appLockDir = pathOnRoot(lockPath(appId));
			const services: string[] = [];
			try {
				// Read the contents of the app lockdir
				const dirs = await fs.readdir(appLockDir);
				const statResults = await Promise.allSettled(
					dirs.map(async (service) => ({
						service,
						stat: await fs.lstat(path.join(appLockDir, service)),
					})),
				);

				for (const res of statResults) {
					// Ignore rejected results
					if (
						res.status === 'fulfilled' &&
						res.value.stat.isDirectory() &&
						!res.value.stat.isSymbolicLink()
					) {
						services.push(res.value.service);
					}
				}
			} catch (e) {
				// If the directory does not exist, continue
				if (isENOENT(e)) {
					continue;
				}
				throw e;
			}

			lockables.push(Lockable.from(appId, services));
		}

		// Lock all apps at once to avoid adding up the wait times
		const lockingResults = await Promise.allSettled(
			lockables.map((l) => l.lock({ force, maxWaitMs })),
		);

		let err = null;
		for (const res of lockingResults) {
			if (res.status === 'fulfilled') {
				locks.push(res.value);
			} else {
				err = res.reason;
			}
		}

		// If there are any errors, then throw before calling the function
		if (err != null) {
			throw err;
		}

		// If we got here, then all locks were successfully acquired
		// call the function now
		return await fn();
	} finally {
		// Unlock all taken locks
		await Promise.all(locks.map((l) => l.unlock()));
	}
}

async function leftoverLocks(appId: string | number) {
	// Find all the locks for the appId that are owned by the supervisor
	return await lockfile.findAll({
		root: pathOnRoot(lockPath(appId)),
		filter: (l) => l.path.endsWith('updates.lock') && l.owner === LOCKFILE_UID,
	});
}

export async function hasLeftoverLocks(appId: string | number) {
	const leftover = await leftoverLocks(appId);
	return leftover.length > 0;
}

export async function cleanLocksForApp(
	appId: string | number,
): Promise<boolean> {
	let disposer: ReadWriteLock.Release = () => {
		/* noop */
	};
	try {
		// Take the lock for the app to avoid removing locks used somewhere
		// else. Wait at most 10ms. If the process lock is taken elsewhere
		// it is expected that cleanup will happen after it is released anyway
		disposer = await takeGlobalLockOrFail(appId.toString(), 10);

		// Find all the locks for the appId that are owned by the supervisor
		const currentLocks = await leftoverLocks(appId);

		// Remove any remaining locks
		await Promise.all(currentLocks.map((l) => fs.rm(l)));
		return true;
	} catch (e) {
		if (e instanceof UpdatesLockedError) {
			// Ignore locking  errors when trying to take the global lock
			return false;
		}
		throw e;
	} finally {
		disposer();
	}
}
