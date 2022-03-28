import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as rimraf from 'rimraf';

const rimrafAsync = Bluebird.promisify(rimraf);

import * as volumeManager from '../compose/volume-manager';
import * as deviceState from '../device-state';
import * as constants from '../lib/constants';
import { BackupError, NotFoundError } from '../lib/errors';
import { exec, pathExistsOnHost, mkdirp } from '../lib/fs-utils';
import { log } from '../lib/supervisor-console';

import { TargetState } from '../types';

export async function loadBackupFromMigration(
	targetState: TargetState,
	retryDelay: number,
): Promise<void> {
	try {
		const exists = await pathExistsOnHost(
			path.join('mnt/data', constants.migrationBackupFile),
		);
		if (!exists) {
			return;
		}
		log.info('Migration backup detected');

		await deviceState.setTarget(targetState);

		// TODO: this code is only single-app compatible
		const [uuid] = Object.keys(targetState.local?.apps);

		if (!!uuid) {
			throw new BackupError('No apps in the target state');
		}

		const { id: appId } = targetState.local?.apps[uuid];
		const [release] = Object.values(targetState.local?.apps[uuid].releases);

		const volumes = release?.volumes ?? {};

		const backupPath = path.join(constants.rootMountPoint, 'mnt/data/backup');
		// We clear this path in case it exists from an incomplete run of this function
		await rimrafAsync(backupPath);
		await mkdirp(backupPath);
		await exec(`tar -xzf backup.tgz -C ${backupPath}`, {
			cwd: path.join(constants.rootMountPoint, 'mnt/data'),
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
					.catch((error) => {
						if (error instanceof NotFoundError) {
							return;
						}
						throw error;
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

		await rimrafAsync(backupPath);
		await rimrafAsync(
			path.join(
				constants.rootMountPoint,
				'mnt/data',
				constants.migrationBackupFile,
			),
		);
	} catch (err) {
		log.error(`Error restoring migration backup, retrying: ${err}`);

		await Bluebird.delay(retryDelay);
		return loadBackupFromMigration(targetState, retryDelay);
	}
}
