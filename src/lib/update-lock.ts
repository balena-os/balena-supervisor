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
import log from '../lib/supervisor-console';

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

type LockFn = (key: string | number) => Promise<() => void>;
const locker = new Lock();
export const writeLock: LockFn = Bluebird.promisify(locker.async.writeLock, {
	context: locker,
});
export const readLock: LockFn = Bluebird.promisify(locker.async.readLock, {
	context: locker,
});

async function dispose(appIdentifier: string | number): Promise<void> {
	const locks = lockfile.getLocksTaken((p: string) =>
		p.includes(`${BASE_LOCK_DIR}/${appIdentifier}`),
	);
	await Promise.all(locks.map((l) => lockfile.unlock(l)));
}

/**
 * Attempts to take locks for list of application IDs provided
 * Waits until all applications are locked before running the passed function
 */
export async function lockAll<T extends unknown>(
	appIds: number[],
	force = false,
	fn: () => Resolvable<T>,
): Promise<T | undefined> {
	if (appIds.length === 0) {
		throw new UpdatesLockedError(
			'Tried to obtain lock for empty list of applications',
		);
	}
	let lockCounter = 0;
	// Closure to create recursive locks for N appIds
	const nextLock = async (): Promise<Resolvable<T>> => {
		lockCounter++;
		return lock(
			appIds[lockCounter],
			{ force },
			lockCounter + 1 === appIds.length ? fn : nextLock,
		);
	};
	// If there is only 1 application call fn without making more locks
	return lock(appIds[0], { force }, appIds.length === 1 ? fn : nextLock);
}

/**
 * Try to take the locks for an application. If force is set, it will remove
 * all existing lockfiles before performing the operation
 *
 * TODO: Remove skipLock as it's not a good interface. If lock is called it should try to take the lock
 * without an option to skip.
 */
export async function lock<T extends unknown>(
	appId: number,
	{ force = false, skipLock = false }: { force: boolean; skipLock?: boolean },
	fn: () => Resolvable<T>,
): Promise<T> {
	if (skipLock || appId == null) {
		return Promise.resolve(fn());
	}

	const lockDir = getPathOnHost(lockPath(appId));
	let lockOverride: boolean;
	try {
		lockOverride = await config.get('lockOverride');
	} catch (err) {
		throw new InternalInconsistencyError(
			`Error getting lockOverride config value: ${err?.message ?? err}`,
		);
	}

	let release;
	try {
		// Acquire write lock for appId
		release = await writeLock(appId);
		// Get list of service folders in lock directory
		let serviceFolders: string[] = [];
		try {
			serviceFolders = await fs.readdir(lockDir);
		} catch (e) {
			log.error(`Error getting lock directory contents - ${e}`);
		}

		// Attempt to create a lock for each service
		await Promise.all(
			serviceFolders.map((service) =>
				lockService(appId, service, { force, lockOverride }),
			),
		);

		// Resolve the function passed
		return Promise.resolve(fn());
	} finally {
		// Cleanup locks
		if (release) {
			release();
		}
		await dispose(appId);
	}
}

type LockOptions = {
	force?: boolean;
	lockOverride?: boolean;
};

async function lockService(
	appId: number,
	service: string,
	opts: LockOptions = {
		force: false,
		lockOverride: false,
	},
): Promise<void> {
	const serviceLockFiles = lockFilesOnHost(appId, service);
	for await (const file of serviceLockFiles) {
		try {
			if (opts.force || opts.lockOverride) {
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
