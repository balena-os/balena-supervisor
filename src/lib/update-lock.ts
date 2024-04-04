import { promises as fs } from 'fs';
import path from 'path';
import { isRight } from 'fp-ts/lib/Either';

import {
	ENOENT,
	UpdatesLockedError,
	InternalInconsistencyError,
} from './errors';
import { pathOnRoot, pathExistsOnState } from './host-utils';
import { mkdirp } from './fs-utils';
import * as config from '../config';
import * as lockfile from './lockfile';
import { NumericIdentifier, StringIdentifier, DockerName } from '../types';
import { takeGlobalLockRW } from './process-lock';

const decodedUid = NumericIdentifier.decode(process.env.LOCKFILE_UID);
export const LOCKFILE_UID = isRight(decodedUid) ? decodedUid.right : 65534;

export const BASE_LOCK_DIR =
	process.env.BASE_LOCK_DIR || '/tmp/balena-supervisor/services';

export function lockPath(appId: number, serviceName?: string): string {
	return path.join(BASE_LOCK_DIR, appId.toString(), serviceName ?? '');
}

function lockFilesOnHost(appId: number, serviceName: string): string[] {
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
export function abortIfHUPInProgress({
	force = false,
}: {
	force: boolean | undefined;
}): Promise<boolean | never> {
	return Promise.all(
		['rollback-health-breadcrumb', 'rollback-altboot-breadcrumb'].map(
			(filename) => pathExistsOnState(filename),
		),
	).then((existsArray) => {
		const anyExists = existsArray.some((e) => e);
		if (anyExists && !force) {
			throw new UpdatesLockedError('Waiting for Host OS update to finish');
		}
		return anyExists;
	});
}

/**
 * Unlock all lockfiles of an appId | appUuid, then release resources.
 * Meant for use in update-lock module only as as it assumes that a
 * write lock has been acquired.
 */
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
 * Composition step used by Supervisor compose module.
 * Take all locks for an appId | appUuid, creating directories if they don't exist.
 */
export async function takeLock(
	appId: number,
	services: string[],
	force: boolean = false,
) {
	const release = await takeGlobalLockRW(appId);
	try {
		const actuallyLocked: string[] = [];
		// Filter out services that already have Supervisor-taken locks.
		// This needs to be done after taking the appId write lock to avoid
		// race conditions with locking.
		const servicesWithoutLock = services.filter(
			(svc) => !getServicesLockedByAppId().isLocked(appId, svc),
		);
		for (const service of servicesWithoutLock) {
			await mkdirp(pathOnRoot(lockPath(appId, service)));
			await lockService(appId, service, force);
			actuallyLocked.push(service);
		}
		return actuallyLocked;
	} finally {
		release();
	}
}

/**
 * Composition step used by Supervisor compose module.
 * Release all locks for an appId | appUuid.
 */
export async function releaseLock(appId: number) {
	const release = await takeGlobalLockRW(appId);
	await dispose(appId, release);
}

/**
 * Given a lockfile path `p`, return a tuple [appId, serviceName] of that path.
 * Paths are assumed to end in the format /:appId/:serviceName/(resin-)updates.lock.
 */
function getIdentifiersFromPath(p: string) {
	const parts = p.split('/');
	if (parts.pop()?.match(/updates\.lock/) === null) {
		return [];
	}
	const serviceName = parts.pop();
	const appId = parts.pop();
	return [appId, serviceName];
}

type LockedEntity = { appId: number; services: string[] };

/**
 * A map of locked services by appId.
 * Exported for tests only; getServicesLockedByAppId is the public generator interface.
 */
export class LocksTakenMap extends Map<number, Set<string>> {
	constructor(lockedEntities: LockedEntity[] = []) {
		// Construct a Map<number, Set<string>> from user-friendly input args
		super(
			lockedEntities.map(({ appId, services }) => [appId, new Set(services)]),
		);
	}

	// Add one or more locked services to an appId
	public add(appId: number, services: string | string[]): void {
		if (typeof services === 'string') {
			services = [services];
		}
		if (this.has(appId)) {
			const lockedSvcs = this.get(appId)!;
			services.forEach((s) => lockedSvcs.add(s));
		} else {
			this.set(appId, new Set(services));
		}
	}

	/**
	 * @private Use this.getServices instead as there is no need to return
	 * a mutable reference to the internal Set data structure.
	 */
	public get(appId: number): Set<string> | undefined {
		return super.get(appId);
	}

	// Return an array copy of locked services under an appId
	public getServices(appId: number): string[] {
		return this.has(appId) ? Array.from(this.get(appId)!) : [];
	}

	// Return whether a service is locked under an appId
	public isLocked(appId: number, service: string): boolean {
		return this.has(appId) && this.get(appId)!.has(service);
	}
}

/**
 * Return a list of services that are locked by the Supervisor under each appId.
 */
export function getServicesLockedByAppId(): LocksTakenMap {
	const locksTaken = lockfile.getLocksTaken();
	const servicesByAppId = new LocksTakenMap();
	for (const lockTakenPath of locksTaken) {
		const [appId, serviceName] = getIdentifiersFromPath(lockTakenPath);
		if (!StringIdentifier.is(appId) || !DockerName.is(serviceName)) {
			continue;
		}
		const numAppId = +appId;
		servicesByAppId.add(numAppId, serviceName);
	}
	return servicesByAppId;
}

/**
 * Try to take the locks for an application. If force is set, it will remove
 * all existing lockfiles before performing the operation
 *
 * TODO: convert to native Promises and async/await. May require native implementation of Bluebird's dispose / using
 */
export async function lock<T>(
	appId: number | number[],
	{ force = false }: { force: boolean },
	fn: () => Resolvable<T>,
): Promise<T> {
	const appIdsToLock = Array.isArray(appId) ? appId : [appId];
	if (!appId || !appIdsToLock.length) {
		return fn();
	}

	// Sort appIds so they are always locked in the same sequence
	const sortedIds = appIdsToLock.sort();

	let lockOverride: boolean;
	try {
		lockOverride = await config.get('lockOverride');
	} catch (err: any) {
		throw new InternalInconsistencyError(
			`Error getting lockOverride config value: ${err?.message ?? err}`,
		);
	}

	const releases = new Map<number, () => void>();
	try {
		for (const id of sortedIds) {
			const lockDir = pathOnRoot(lockPath(id));
			// Acquire write lock for appId
			releases.set(id, await takeGlobalLockRW(id));
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
		return await fn();
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
