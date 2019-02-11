import * as Dockerode from 'dockerode';
import * as _ from 'lodash';
import * as path from 'path';

import Docker from '../lib/docker-utils';
import Logger from '../logger';

import constants = require('../lib/constants');
import { safeRename } from '../lib/fs-utils';
import { defaultLegacyVolume } from '../lib/migration';
import { ConfigMap } from './types/service';

import Volume from './volume';

interface VolumeConstructOpts {
	docker: Docker;
	logger: Logger;
}

export interface VolumeNameOpts {
	name: string;
	appId: number;
}

export class VolumeManager {
	private docker: Docker;
	private logger: Logger;

	public constructor(opts: VolumeConstructOpts) {
		this.docker = opts.docker;
		this.logger = opts.logger;
	}

	public async getAll(): Promise<Volume[]> {
		const volumes = await this.listWithBothLabels();
		return volumes.map(v =>
			Volume.fromDockerVolume(
				{
					docker: this.docker,
					logger: this.logger,
					...Volume.splitName(v.Name),
				},
				v,
			),
		);
	}

	public async getAllByAppId(appId: number): Promise<Volume[]> {
		const all = await this.getAll();
		return _.filter(all, { appId });
	}

	public async get({ name, appId }: VolumeNameOpts): Promise<Volume> {
		const volume = await this.docker
			.getVolume(Volume.generateName(name, appId))
			.inspect();
		return Volume.fromDockerVolume(
			{
				docker: this.docker,
				logger: this.logger,
				name,
				appId,
			},
			volume,
		);
	}

	public async createFromLegacy(appId: number): Promise<void> {
		const name = defaultLegacyVolume();
		const legacyPath = path.join(
			constants.rootMountPoint,
			'mnt/data/resin-data',
			appId.toString(),
		);

		try {
			return await this.createFromPath({ name, appId }, legacyPath);
		} catch (e) {
			this.logger.logSystemMessage(
				`Warning: could not migrate legacy /data volume: ${e.message}`,
				{ error: e },
				'Volume migration error',
			);
		}
	}

	// oldPath must be a path inside /mnt/data
	public async createFromPath(
		{
			name,
			appId,
			config = {},
		}: { name: string; appId: number; config?: ConfigMap },
		oldPath: string,
	): Promise<void> {
		const volume = Volume.fromComposeObject(
			{
				appId,
				name,
				docker: this.docker,
				logger: this.logger,
			},
			config,
		);
		const handle = await this.docker.getVolume(volume.name).inspect();

		// Convert the path to be of the same mountpoint so that rename can work
		const volumePath = path.join(
			constants.rootMountPoint,
			'mnt/data',
			...handle.Mountpoint.split(path.sep).slice(3),
		);
		await safeRename(oldPath, volumePath);
	}

	private async listWithBothLabels(): Promise<Dockerode.VolumeInspectInfo[]> {
		const [legacyResponse, currentResponse] = await Promise.all([
			this.docker.listVolumes({
				filters: { label: ['io.resin.supervised'] },
			}),
			this.docker.listVolumes({
				filters: { label: ['io.balena.supervised'] },
			}),
		]);

		const legacyVolumes = _.get(legacyResponse, 'Volumes', []);
		const currentVolumes = _.get(currentResponse, 'Volumes', []);
		return _.unionBy(legacyVolumes, currentVolumes, 'Name');
	}
}

export default VolumeManager;
