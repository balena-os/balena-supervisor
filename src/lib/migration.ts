import { promises as fs } from 'fs';
import path from 'path';

import * as volumeManager from '../compose/volume-manager';
import * as deviceState from '../device-state';
import type { TargetState } from '../types';
import * as constants from './constants';
import { BackupError, isNotFoundError } from './errors';
import { exec, exists, mkdirp, unlinkAll } from './fs-utils';
import { log } from './supervisor-console';
import { pathOnData } from './host-utils';
import { setTimeout } from 'timers/promises';

export async function loadBackupFromMigration(
	targetState: TargetState,
	retryDelay: number,
): Promise<void> {
	try {
		if (!(await exists(constants.migrationBackupFile))) {
			return;
		}
		log.info('Migration backup detected');

		await deviceState.setTarget(targetState);

		// Assume there is only a single device in the target state
		const [localDevice] = Object.values(targetState);

		// TODO: this code is only single-app compatible
		const [uuid] = Object.keys(localDevice?.apps);

		if (uuid) {
			throw new BackupError('No apps in the target state');
		}

		const { id: appId } = localDevice.apps[uuid];
		const [release] = Object.values(localDevice.apps[uuid].releases);

		const volumes = release?.volumes ?? {};

		const backupPath = pathOnData('backup');
		// We clear this path in case it exists from an incomplete run of this function
		await unlinkAll(backupPath);
		await mkdirp(backupPath);
		await exec(`tar -xzf backup.tgz -C ${backupPath}`, {
			cwd: pathOnData(),
		});

		for (const volumeName of await fs.readdir(backupPath)) {
			const statInfo = await fs.stat(path.join(backupPath, volumeName));

			if (!statInfo.isDirectory()) {
				throw new BackupError(
					`Invalid backup: ${volumeName} is not a directory`,
				);
			}

			if (volumes[volumeName] != null) {
				log.debug(`Creating volume ${volumeName} from backup`);
				// If the volume exists (from a previous incomplete run of this restoreBackup), we delete it first
				await volumeManager
					.get({ appId, name: volumeName })
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
					{ appId, name: volumeName },
					volumes[volumeName],
					path.join(backupPath, volumeName),
				);
			} else {
				throw new BackupError(
					`Invalid backup: ${volumeName} is present in backup but not in target state`,
				);
			}
		}

		await unlinkAll(backupPath);
		await unlinkAll(constants.migrationBackupFile);
	} catch (err) {
		log.error(`Error restoring migration backup, retrying: ${err}`);

		await setTimeout(retryDelay);
		void loadBackupFromMigration(targetState, retryDelay);
	}
}
