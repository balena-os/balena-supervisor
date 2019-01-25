import * as Dockerode from 'dockerode';
import * as _ from 'lodash';
import * as path from 'path';

import Docker from '../lib/docker-utils';
import Logger from '../logger';

import constants = require('../lib/constants');
import { InternalInconsistencyError, NotFoundError } from '../lib/errors';
import { safeRename } from '../lib/fs-utils';
import * as LogTypes from '../lib/log-types';
import { defaultLegacyVolume } from '../lib/migration';
import { LabelObject } from '../lib/types';
import { checkInt } from '../lib/validation';
import * as ComposeUtils from './utils';

interface VolumeConstructOpts {
	docker: Docker;
	logger: Logger;
}

export interface ComposeVolume {
	name: string;
	appId: number;
	config: {
		labels: LabelObject;
		driverOpts: Dockerode.VolumeInspectInfo['Options'];
	};
	dockerVolume: Dockerode.VolumeInspectInfo;
}

interface VolumeNameOpts {
	name: string;
	appId: number;
}

// This weird type is currently needed because the create function (and helpers)
// accept either a docker volume or a compose volume (or an empty object too apparently).
// If we instead split the tasks into createFromCompose and createFromDocker, we will no
// longer have this issue (and weird typing)
type VolumeConfig = ComposeVolume['config'] | Dockerode.VolumeInspectInfo | {};
type VolumeCreateOpts = VolumeNameOpts & {
	config?: VolumeConfig;
};

export class Volumes {
	private docker: Docker;
	private logger: Logger;

	public constructor(opts: VolumeConstructOpts) {
		this.docker = opts.docker;
		this.logger = opts.logger;
	}

	public async getAll(): Promise<ComposeVolume[]> {
		const volumes = await this.listWithBothLabels();
		return volumes.map(Volumes.format);
	}

	public async getAllByAppId(appId: number): Promise<ComposeVolume[]> {
		const all = await this.getAll();
		return _.filter(all, { appId });
	}

	public async get({ name, appId }: VolumeNameOpts): Promise<ComposeVolume> {
		const volume = await this.docker.getVolume(`${appId}_${name}`).inspect();
		return Volumes.format(volume);
	}

	public async create(opts: VolumeCreateOpts): Promise<ComposeVolume> {
		const { name, config = {}, appId } = opts;
		const camelCaseConfig: Dictionary<unknown> = _.mapKeys(config, (_v, k) =>
			_.camelCase(k),
		);

		this.logger.logSystemEvent(LogTypes.createVolume, { volume: { name } });

		const labels = _.clone(camelCaseConfig.labels as LabelObject) || {};
		_.assign(labels, constants.defaultVolumeLabels);

		const driverOpts: Dictionary<unknown> =
			camelCaseConfig.driverOpts != null
				? (camelCaseConfig.driverOpts as Dictionary<unknown>)
				: {};

		try {
			const volume = await this.get({ name, appId });
			if (!this.isEqualConfig(volume.config, config)) {
				throw new InternalInconsistencyError(
					`Trying to create volume '${name}', but a volume with the same name and different configuration exists`,
				);
			}
			return volume;
		} catch (e) {
			if (!NotFoundError(e)) {
				this.logger.logSystemEvent(LogTypes.createVolumeError, {
					volume: { name },
					error: e,
				});
				throw e;
			}
			const volume = await this.docker.createVolume({
				Name: Volumes.generateVolumeName({ name, appId }),
				Labels: labels,
				DriverOpts: driverOpts,
			});

			return Volumes.format(await volume.inspect());
		}
	}

	public async createFromLegacy(appId: number): Promise<ComposeVolume | void> {
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
		opts: VolumeCreateOpts,
		oldPath: string,
	): Promise<void> {
		const volume = await this.create(opts);
		const handle = volume.dockerVolume;

		// Convert the path to be of the same mountpoint so that rename can work
		const volumePath = path.join(
			constants.rootMountPoint,
			'mnt/data',
			...handle.Mountpoint.split(path.sep).slice(3),
		);
		await safeRename(oldPath, volumePath);
	}

	public async remove({ name, appId }: VolumeNameOpts) {
		this.logger.logSystemEvent(LogTypes.removeVolume, { volume: { name } });
		try {
			await this.docker
				.getVolume(Volumes.generateVolumeName({ name, appId }))
				.remove();
		} catch (e) {
			this.logger.logSystemEvent(LogTypes.removeVolumeError, {
				volume: { name, appId },
				error: e,
			});
		}
	}

	public isEqualConfig(current: VolumeConfig, target: VolumeConfig): boolean {
		const currentConfig = (_.mapKeys(current, (_v, k) =>
			_.camelCase(k),
		) as unknown) as ComposeVolume['config'];
		const targetConfig = (_.mapKeys(target, (_v, k) =>
			_.camelCase(k),
		) as unknown) as ComposeVolume['config'];

		const currentOpts = currentConfig.driverOpts || {};
		const targetOpts = targetConfig.driverOpts || {};

		const currentLabels = currentConfig.labels || {};
		const targetLabels = targetConfig.labels || {};

		return (
			_.isEqual(currentOpts, targetOpts) &&
			_.isEqual(currentLabels, targetLabels)
		);
	}

	private static format(volume: Dockerode.VolumeInspectInfo): ComposeVolume {
		const match = volume.Name.match(/^([0-9]+)_(.+)$/);
		if (match == null) {
			throw new Error('Malformed volume name in Volume.format');
		}
		const appId = checkInt(match[1]);
		const name = match[2];

		return {
			name,
			// We know this cast is fine due to the regex
			appId: appId as number,
			config: {
				labels: _.omit(
					ComposeUtils.normalizeLabels(volume.Labels),
					_.keys(constants.defaultVolumeLabels),
				),
				driverOpts: volume.Options,
			},
			dockerVolume: volume,
		};
	}

	private async listWithBothLabels(): Promise<Dockerode.VolumeInspectInfo[]> {
		// We have to cast the listVolumes call from any[] to any below, until the
		// relevant PR: https://github.com/DefinitelyTyped/DefinitelyTyped/pull/32383
		// is merged and released - we can also replace Dockerode here with the Docker
		// DockerUtils class imported above
		const [legacyResponse, currentResponse]: [
			Dockerode.VolumeInfoList,
			Dockerode.VolumeInfoList
		] = await Promise.all([
			this.docker.listVolumes({
				filters: { label: ['io.resin.supervised'] },
			}) as Promise<any>,
			this.docker.listVolumes({
				filters: { label: ['io.balena.supervised'] },
			}) as Promise<any>,
		]);

		const legacyVolumes = _.get(legacyResponse, 'Volumes', []);
		const currentVolumes = _.get(currentResponse, 'Volumes', []);
		return _.unionBy(legacyVolumes, currentVolumes, 'Name');
	}

	private static generateVolumeName({ name, appId }: VolumeNameOpts) {
		return `${appId}_${name}`;
	}
}

export default Volumes;
