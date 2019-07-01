import * as Docker from 'dockerode';
import filter = require('lodash/filter');
import get = require('lodash/get');
import unionBy = require('lodash/unionBy');
import * as Path from 'path';

import constants = require('../lib/constants');
import { InternalInconsistencyError, NotFoundError } from '../lib/errors';
import { safeRename } from '../lib/fs-utils';
import * as LogTypes from '../lib/log-types';
import { defaultLegacyVolume } from '../lib/migration';
import Logger from '../logger';
import Volume, { VolumeConfig } from './volume';

export interface VolumeMangerConstructOpts {
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

	public constructor(opts: VolumeMangerConstructOpts) {
		this.docker = opts.docker;
		this.logger = opts.logger;
	}

	public async get({ name, appId }: VolumeNameOpts): Promise<Volume> {
		return Volume.fromDockerVolume(
			{ docker: this.docker, logger: this.logger },
			await this.docker
				.getVolume(Volume.generateDockerName(appId, name))
				.inspect(),
		);
	}

	public async getAll(): Promise<Volume[]> {
		const volumeInspect = await this.listWithBothLabels();
		return volumeInspect.map(inspect =>
			Volume.fromDockerVolume(
				{ logger: this.logger, docker: this.docker },
				inspect,
			),
		);
	}

	public async getAllByAppId(appId: number): Promise<Volume[]> {
		const all = await this.getAll();
		return filter(all, { appId });
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
				throw new InternalInconsistencyError(
					`Trying to create volume '${
						volume.name
					}', but a volume with the same name and different configuration exists`,
				);
			}
		} catch (e) {
			if (!NotFoundError(e)) {
				this.logger.logSystemEvent(LogTypes.createVolumeError, {
					volume: { name: volume.name },
					error: e,
				});
				throw e;
			}

			await volume.create();
		}
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
			this.logger.logSystemMessage(
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
		const volume = Volume.fromComposeVolume(name, appId, config, {
			logger: this.logger,
			docker: this.docker,
		});

		await this.create(volume);
		const inspect = await this.docker
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

	private async listWithBothLabels(): Promise<Docker.VolumeInspectInfo[]> {
		const [legacyResponse, currentResponse] = await Promise.all([
			this.docker.listVolumes({
				filters: { label: ['io.resin.supervised'] },
			}),
			this.docker.listVolumes({
				filters: { label: ['io.balena.supervised'] },
			}),
		]);

		const legacyVolumes = get(legacyResponse, 'Volumes', []);
		const currentVolumes = get(currentResponse, 'Volumes', []);
		return unionBy(legacyVolumes, currentVolumes, 'Name');
	}
}

export default VolumeManager;
