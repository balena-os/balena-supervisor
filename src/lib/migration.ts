import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';

import { App } from '../compose/app';
import * as volumeManager from '../compose/volume-manager';
import { Volume } from '../compose/volume';
import * as deviceState from '../device-state';
import { InstancedDeviceState, TargetState } from '../types';
import * as constants from './constants';
import { BackupError, isNotFoundError } from './errors';
import { exec, exists, mkdirp, unlinkAll } from './fs-utils';
import { log } from './supervisor-console';
import { pathOnData } from './host-utils';
import { setTimeout } from 'timers/promises';

/**
 * Collects volumes with a provided name from apps in the device state. Supports multi-app.
 */
function collectVolumes(
	name: string,
	localState: InstancedDeviceState,
): Volume[] {
	const vols = [] as Volume[];

	const apps = Object.values(localState.local.apps) as App[];
	for (const app of apps) {
		vols.push(...app.volumes.filter((vol) => vol.name === name));
	}
	return vols;
}

/**
 * Loads application data from a migration backup file (likely /mnt/data/backup.tgz)
 * into data volumes. We expect the backup file to be an archive of a filesystem
 * where each of the the top level entries must be a directory. Each top level entry
 * must identify a volume in the provided target state.
 *
 * Note: targetState parameter is not necessary. This function is called only after
 * targetState already has been set.
 */
export async function loadBackupFromMigration(
	targetState: TargetState,
	retryDelay: number,
): Promise<void> {
	try {
		if (!(await exists(constants.migrationBackupFile))) {
			return;
		}
		log.info('Migration backup detected');

		// remove this line; see function comment
		await deviceState.setTarget(targetState);
		const localState = await deviceState.getTarget();
		// log.debug(`localState: ${JSON.stringify(localState)}`);

		// Verify at least one app is present.
		if (!Object.keys(localState.local.apps)) {
			throw new BackupError('No apps in the target state');
		}

		const backupPath = pathOnData('backup');
		// We clear this path in case it exists from an incomplete run of this function
		await unlinkAll(backupPath);
		await mkdirp(backupPath);
		log.debug('About to extract backup to /mnt/data/backup');
		await exec(`tar -xzf backup.tgz -C ${backupPath}`, {
			cwd: pathOnData(),
		});

		for (const volumeName of await fs.readdir(backupPath)) {
			log.debug(`processing backup dir: ${volumeName}`);
			const statInfo = await fs.stat(path.join(backupPath, volumeName));

			if (!statInfo.isDirectory()) {
				throw new BackupError(
					`Invalid backup: ${volumeName} is not a directory`,
				);
			}

			const volumes = collectVolumes(volumeName, localState);
			if (!volumes) {
				throw new BackupError(
					`Invalid backup: ${volumeName} is present in backup but not in target state`,
				);
			}
			if (volumes.length > 1) {
				throw new BackupError(
					`Invalid backup: ${volumeName} ambiguous; found in more than one app`,
				);
			}
			log.debug(`Creating volume ${volumeName} from backup`);
			// If the volume exists (from a previous incomplete run of this restoreBackup), we delete it first
			await volumeManager
				.get({ appId: volumes[0].appId, name: volumeName })
				.then((volume) => {
					return volume.remove();
				})
				.catch((e: unknown) => {
					if (isNotFoundError(e)) {
						return;
					}
					throw e;
				});

			await volumeManager.createFromPath(
				{ appId: volumes[0].appId, name: volumeName },
				volumes[0].config,
				path.join(backupPath, volumeName),
			);
		}

		await unlinkAll(backupPath);
		await unlinkAll(constants.migrationBackupFile);
	} catch (err) {
		log.error(`Error restoring migration backup, retrying: ${err}`);

		await setTimeout(retryDelay);
		return loadBackupFromMigration(targetState, retryDelay);
	}
}
