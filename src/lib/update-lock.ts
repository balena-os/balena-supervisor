import * as Bluebird from 'bluebird';
import * as lockFileLib from 'lockfile';
import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as Lock from 'rwlock';

import * as constants from './constants';
import {
	ENOENT,
	EEXIST,
	UpdatesLockedError,
	InternalInconsistencyError,
} from './errors';
import { getPathOnHost, pathExistsOnHost } from './fs-utils';
import * as config from '../config';

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

export function lockPath(appId: number, serviceName?: string): string {
	return path.join(
		'/tmp/balena-supervisor/services',
		appId.toString(),
		serviceName ?? '',
	);
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

const locksTaken: { [lockName: string]: boolean } = {};

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
	return Bluebird.map(_.keys(locksTaken), (lockName) => {
		delete locksTaken[lockName];
		return lockFile.unlockAsync(lockName);
	})
		.finally(release)
		.return();
}

const lockExistsErrHandler = (err: Error, release: () => void) => {
	let errMsg = err.message;
	if (EEXIST(err)) {
		// Extract appId|appUuid and serviceName from lockfile path for log message
		// appId: [0-9]{7}, appUuid: [0-9a-w]{32}, short appUuid: [0-9a-w]{7}
		const pathMatch = err.message.match(
			/\/([0-9]{7}|[0-9a-w]{32}|[0-9a-w]{7})\/(.*)\/(?:resin-)?updates.lock/,
		);
		if (pathMatch && pathMatch.length === 3) {
			errMsg = `Lockfile exists for ${JSON.stringify({
				serviceName: pathMatch[2],
				[/^[0-9]{7}$/.test(pathMatch[1]) ? 'appId' : 'appUuid']: pathMatch[1],
			})}`;
		}
	}
	return dispose(release).throw(new UpdatesLockedError(errMsg));
};

/**
 * Try to take the locks for an application. If force is set, it will remove
 * all existing lockfiles before performing the operation
 *
 * TODO: convert to native Promises. May require native implementation of Bluebird's dispose / using
 *
 * TODO: Remove skipLock as it's not a good interface. If lock is called it should try to take the lock
 * without an option to skip.
 */
export function lock<T extends unknown>(
	appId: number | null,
	{ force = false, skipLock = false }: { force: boolean; skipLock?: boolean },
	fn: () => Resolvable<T>,
): Bluebird<T> {
	if (skipLock) {
		return Bluebird.resolve(fn());
	}

	const takeTheLock = () => {
		if (appId == null) {
			return;
		}
		return config
			.get('lockOverride')
			.then((lockOverride) => {
				return writeLock(appId)
					.tap((release: () => void) => {
						const [lockDir] = getPathOnHost(lockPath(appId));

						return Bluebird.resolve(fs.readdir(lockDir))
							.catchReturn(ENOENT, [])
							.mapSeries((serviceName) => {
								return Bluebird.mapSeries(
									lockFilesOnHost(appId, serviceName),
									(tmpLockName) => {
										return Bluebird.try(() => {
											if (force || lockOverride) {
												return lockFile.unlockAsync(tmpLockName);
											}
										})
											.then(() => lockFile.lockAsync(tmpLockName))
											.then(() => {
												locksTaken[tmpLockName] = true;
											})
											.catchReturn(ENOENT, undefined);
									},
								);
							})
							.catch((err) => lockExistsErrHandler(err, release));
					})
					.disposer(dispose);
			})
			.catch((err) => {
				throw new InternalInconsistencyError(
					`Error getting lockOverride config value: ${err?.message ?? err}`,
				);
			});
	};

	const disposer = takeTheLock();
	if (disposer) {
		return Bluebird.using(disposer, fn as () => PromiseLike<T>);
	} else {
		return Bluebird.resolve(fn());
	}
}
