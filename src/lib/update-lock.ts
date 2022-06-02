import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as Lock from 'rwlock';
import { isRight } from 'fp-ts/lib/Either';

import * as constants from './constants';
import {
	ENOENT,
	UpdatesLockedError,
	InternalInconsistencyError,
} from './errors';
import { getPathOnHost, pathExistsOnHost } from './fs-utils';
import * as config from '../config';
import * as lockfile from './lockfile';
import { NumericIdentifier } from '../types';

const decodedUid = NumericIdentifier.decode(process.env.LOCKFILE_UID);
export const LOCKFILE_UID = isRight(decodedUid) ? decodedUid.right : 65534;

export const BASE_LOCK_DIR =
	process.env.BASE_LOCK_DIR || '/tmp/balena-supervisor/services';

export function lockPath(appId: number, serviceName?: string): string {
	return path.join(BASE_LOCK_DIR, appId.toString(), serviceName ?? '');
}

function lockFilesOnHost(appId: number, serviceName: string): string[] {
	return getPathOnHost(
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
export function abortIfHUPInProgress({
	force = false,
}: {
	force: boolean | undefined;
}): Promise<boolean | never> {
	return Promise.all(
		[
			'rollback-health-breadcrumb',
			'rollback-altboot-breadcrumb',
		].map((filename) =>
			pathExistsOnHost(path.join(constants.stateMountPoint, filename)),
		),
	).then((existsArray) => {
		const anyExists = existsArray.some((exists) => exists);
		if (anyExists && !force) {
			throw new UpdatesLockedError('Waiting for Host OS update to finish');
		}
		return anyExists;
	});
}

type LockFn = (key: string | number) => Bluebird<() => void>;
const locker = new Lock();
export const writeLock: LockFn = Bluebird.promisify(locker.async.writeLock, {
	context: locker,
});
export const readLock: LockFn = Bluebird.promisify(locker.async.readLock, {
	context: locker,
});

// Unlock all lockfiles, optionally of an appId | appUuid, then release resources.
async function dispose(
	appIdentifier: string | number,
	release: () => void,
): Promise<void> {
	const locks = lockfile.getLocksTaken((p: string) =>
		p.includes(`${BASE_LOCK_DIR}/${appIdentifier}`),
	);
	try {
		// Try to unlock all locks taken
		await Promise.all(locks.map((l) => lockfile.unlock(l)));
	} finally {
		// Release final resource
		release();
	}
}

/**
 * Try to take the locks for an application. If force is set, it will remove
 * all existing lockfiles before performing the operation
 *
 * TODO: convert to native Promises and async/await. May require native implementation of Bluebird's dispose / using
 *
 * TODO: Remove skipLock as it's not a good interface. If lock is called it should try to take the lock
 * without an option to skip.
 */
export async function lock<T extends unknown>(
	appId: number | number[],
	{ force = false, skipLock = false }: { force: boolean; skipLock?: boolean },
	fn: () => Resolvable<T>,
): Promise<T> {
	const appIdsToLock = Array.isArray(appId) ? appId : [appId];
	if (skipLock || !appId || !appIdsToLock.length) {
		return fn();
	}

	// Sort appIds so they are always locked in the same sequence
	const sortedIds = appIdsToLock.sort();

	let lockOverride: boolean;
	try {
		lockOverride = await config.get('lockOverride');
	} catch (err) {
		throw new InternalInconsistencyError(
			`Error getting lockOverride config value: ${err?.message ?? err}`,
		);
	}

	const releases = new Map<number, () => void>();
	try {
		for (const id of sortedIds) {
			const lockDir = getPathOnHost(lockPath(id));
			// Acquire write lock for appId
			releases.set(id, await writeLock(id));
			// Get list of service folders in lock directory
			const serviceFolders = await fs.readdir(lockDir).catch((e) => {
				if (ENOENT(e)) {
					return [];
				}
				throw e;
			});
			// Attempt to create a lock for each service
			for (const service of serviceFolders) {
				await lockService(id, service, force || lockOverride);
			}
		}
		// Resolve the function passed
		return fn();
	} finally {
		for (const [id, release] of releases.entries()) {
			// Try to dispose all the locks
			await dispose(id, release);
		}
	}
}

async function lockService(
	appId: number,
	service: string,
	force: boolean = false,
): Promise<void> {
	const serviceLockFiles = lockFilesOnHost(appId, service);
	for await (const file of serviceLockFiles) {
		try {
			if (force) {
				await lockfile.unlock(file);
			}
			await lockfile.lock(file, LOCKFILE_UID);
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
