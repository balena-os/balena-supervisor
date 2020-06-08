import * as _ from 'lodash';
import * as Path from 'path';
import { VolumeInspectInfo } from 'dockerode';

import constants = require('../lib/constants');
import { NotFoundError } from '../lib/errors';
import { safeRename } from '../lib/fs-utils';
import { docker } from '../lib/docker-utils';
import * as LogTypes from '../lib/log-types';
import { defaultLegacyVolume } from '../lib/migration';
import * as logger from '../logger';
import { ResourceRecreationAttemptError } from './errors';
import Volume, { VolumeConfig } from './volume';

export interface VolumeNameOpts {
	name: string;
	appId: number;
}

export class VolumeManager {
	public async get({ name, appId }: VolumeNameOpts): Promise<Volume> {
		return Volume.fromDockerVolume(
			await docker.getVolume(Volume.generateDockerName(appId, name)).inspect(),
		);
	}

	public async getAll(): Promise<Volume[]> {
		const volumeInspect = await this.listWithBothLabels();
		return volumeInspect.map((inspect) => Volume.fromDockerVolume(inspect));
	}

	public async getAllByAppId(appId: number): Promise<Volume[]> {
		const all = await this.getAll();
		return _.filter(all, { appId });
	}

	public async create(volume: Volume): Promise<void> {
		// First we check that we're not trying to recreate a
		// volume
		try {
			const existing = await this.get({
				name: volume.name,
				appId: volume.appId,
			});

			if (!volume.isEqualConfig(existing)) {
				throw new ResourceRecreationAttemptError('volume', volume.name);
			}
		} catch (e) {
			if (!NotFoundError(e)) {
				logger.logSystemEvent(LogTypes.createVolumeError, {
					volume: { name: volume.name },
					error: e,
				});
				throw e;
			}

			await volume.create();
		}
	}

	// We simply forward this to the volume object, but we
	// add this method to provide a consistent interface
	public async remove(volume: Volume) {
		await volume.remove();
	}

	public async createFromLegacy(appId: number): Promise<Volume | void> {
		const name = defaultLegacyVolume();
		const legacyPath = Path.join(
			constants.rootMountPoint,
			'mnt/data/resin-data',
			appId.toString(),
		);

		try {
			return await this.createFromPath({ name, appId }, {}, legacyPath);
		} catch (e) {
			logger.logSystemMessage(
				`Warning: could not migrate legacy /data volume: ${e.message}`,
				{ error: e },
				'Volume migration error',
			);
		}
	}

	public async createFromPath(
		{ name, appId }: VolumeNameOpts,
		config: Partial<VolumeConfig>,
		oldPath: string,
	): Promise<Volume> {
		const volume = Volume.fromComposeObject(name, appId, config);

		await this.create(volume);
		const inspect = await docker
			.getVolume(Volume.generateDockerName(volume.appId, volume.name))
			.inspect();

		const volumePath = Path.join(
			constants.rootMountPoint,
			'mnt/data',
			...inspect.Mountpoint.split(Path.sep).slice(3),
		);

		await safeRename(oldPath, volumePath);
		return volume;
	}

	public async removeOrphanedVolumes(
		referencedVolumes: string[],
	): Promise<void> {
		// Iterate through every container, and track the
		// references to a volume
		// Note that we're not just interested in containers
		// which are part of the private state, and instead
		// *all* containers. This means we don't remove
		// something that's part of a sideloaded container
		const [dockerContainers, dockerVolumes] = await Promise.all([
			docker.listContainers(),
			docker.listVolumes(),
		]);

		const containerVolumes = _(dockerContainers)
			.flatMap((c) => c.Mounts)
			.filter((m) => m.Type === 'volume')
			// We know that the name must be set, if the mount is
			// a volume
			.map((m) => m.Name as string)
			.uniq()
			.value();
		const volumeNames = _.map(dockerVolumes.Volumes, 'Name');

		const volumesToRemove = _.difference(
			volumeNames,
			containerVolumes,
			// Don't remove any volume which is still referenced
			// in the target state
			referencedVolumes,
		);
		await Promise.all(volumesToRemove.map((v) => docker.getVolume(v).remove()));
	}

	private async listWithBothLabels(): Promise<VolumeInspectInfo[]> {
		const [legacyResponse, currentResponse] = await Promise.all([
			docker.listVolumes({
				filters: { label: ['io.resin.supervised'] },
			}),
			docker.listVolumes({
				filters: { label: ['io.balena.supervised'] },
			}),
		]);

		const legacyVolumes = _.get(legacyResponse, 'Volumes', []);
		const currentVolumes = _.get(currentResponse, 'Volumes', []);
		return _.unionBy(legacyVolumes, currentVolumes, 'Name');
	}
}

export default VolumeManager;
