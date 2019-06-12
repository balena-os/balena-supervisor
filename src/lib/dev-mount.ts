import * as Bluebird from 'bluebird';
import mkdirp = require('mkdirp');
import mknodCb = require('mknod');
import { fs, child_process } from 'mz';
import * as Path from 'path';

import constants = require('./constants');
import { DevMountPopulationError } from './errors';
import log from './supervisor-console';

const mknod = Bluebird.promisify(mknodCb);

export class DevMount {
	public static hostLocation(appId: number, serviceName: string): string {
		// TODO: Export these strings to constants
		return Path.join(
			'/tmp/balena-supervisor/services',
			appId.toString(),
			serviceName,
			'dev',
		);
	}

	private constructor(private location: string) {}

	public static async init(
		appId: number,
		serviceName: string,
	): Promise<DevMount> {
		const location = DevMount.hostLocation(appId, serviceName);
		await new Promise((resolve, reject) => {
			mkdirp(location, err => {
				if (err) {
					console.log('There was an error creating the directory');
					return reject(err);
				}
				resolve();
			});
		});

		const devMount = new DevMount(location);
		// Create a new tmpfs in this directory, which doesn't
		// have the nodev flag
		await devMount.createTmpfs();
		await devMount.populate();
		return devMount;
	}

	private async createTmpfs() {
		try {
			console.log(
				'Creating tmpfs with',
				`mount -t tmpfs -o size=1m tmpfs ${this.supervisorContainerLocation()}`,
			);
			const a = await child_process.exec(
				`mount -t tmpfs -o size=1m tmpfs ${this.supervisorContainerLocation()}`,
			);
			console.log('==================================================');
			console.log(a);
			console.log('==================================================');
		} catch (e) {
			throw new DevMountPopulationError(e);
		}
	}

	private async populate(subPath?: string) {
		const basePath = '/dev';
		const currentPath =
			subPath != null ? Path.join(basePath, subPath) : basePath;
		console.log('Subpath: ', currentPath);

		const entries = await fs.readdir(currentPath);

		for (const entry of entries) {
			const entryFullpath = Path.join(currentPath, entry);
			const relPath = Path.relative(basePath, entryFullpath);
			console.log('relPath: ', relPath);
			const info = await fs.stat(entryFullpath);
			if (info.isDirectory()) {
				// TODO
			} else {
				try {
					console.log('Adding at ', Path.join(this.location, relPath));
					await mknod(Path.join(this.location, relPath), info.mode, info.rdev);
				} catch (e) {
					log.error(`Failed to mirror device file: ${relPath}`);
				}
			}
		}
	}

	private supervisorContainerLocation() {
		return Path.join(constants.rootMountPoint, this.location);
	}
}

export default DevMount;
