import Docker from 'dockerode';
import isEqual from 'lodash/isEqual';
import omitBy from 'lodash/omitBy';

import constants from '../lib/constants';
import { docker } from '../lib/docker-utils';
import { InternalInconsistencyError } from '../lib/errors';
import * as LogTypes from '../lib/log-types';
import { LabelObject } from '../types';
import * as logger from '../logger';
import * as ComposeUtils from './utils';

export interface VolumeConfig {
	labels: LabelObject;
	driver: string;
	driverOpts: Docker.VolumeInspectInfo['Options'];
}

export interface ComposeVolumeConfig {
	driver: string;
	driver_opts: Dictionary<string>;
	labels: LabelObject;
}

export class Volume {
	private constructor(
		public name: string,
		public appId: number,
		public appUuid: string,
		public config: VolumeConfig,
	) {}

	public static fromDockerVolume(inspect: Docker.VolumeInspectInfo): Volume {
		// Convert the docker inspect to the config
		const config: VolumeConfig = {
			labels: inspect.Labels || {},
			driver: inspect.Driver,
			driverOpts: inspect.Options || {},
		};

		// Detect the name and appId from the inspect data
		const { name, appId } = this.deconstructDockerName(inspect.Name);
		const appUuid = config.labels['io.balena.app-uuid'];

		return new Volume(name, appId, appUuid, config);
	}

	public static fromComposeObject(
		name: string,
		appId: number,
		appUuid: string,
		config = {} as Partial<ComposeVolumeConfig>,
	) {
		const filledConfig: VolumeConfig = {
			driverOpts: config.driver_opts || {},
			driver: config.driver || 'local',
			labels: {
				// We only need to assign the labels here, as when we
				// get it from the daemon, they should already be there
				...ComposeUtils.normalizeLabels(config.labels || {}),
				...constants.defaultVolumeLabels,

				// the app uuid will always be in the target state, the
				// only reason this is done this way is to be compatible
				// with loading a volume from backup (see lib/migration)
				...(appUuid && { 'io.balena.app-uuid': appUuid }),
			},
		};

		return new Volume(name, appId, appUuid, filledConfig);
	}

	public toComposeObject(): ComposeVolumeConfig {
		return {
			driver: this.config.driver,
			driver_opts: this.config.driverOpts!,
			labels: this.config.labels,
		};
	}

	public isEqualConfig(volume: Volume): boolean {
		return (
			isEqual(this.config.driver, volume.config.driver) &&
			isEqual(this.config.driverOpts, volume.config.driverOpts) &&
			isEqual(
				Volume.omitSupervisorLabels(this.config.labels),
				Volume.omitSupervisorLabels(volume.config.labels),
			)
		);
	}

	public async create(): Promise<void> {
		logger.logSystemEvent(LogTypes.createVolume, {
			volume: { name: this.name },
		});
		await docker.createVolume({
			Name: Volume.generateDockerName(this.appId, this.name),
			Labels: this.config.labels,
			Driver: this.config.driver,
			DriverOpts: this.config.driverOpts,
		});
	}

	public async remove(): Promise<void> {
		logger.logSystemEvent(LogTypes.removeVolume, {
			volume: { name: this.name },
		});

		try {
			await docker
				.getVolume(Volume.generateDockerName(this.appId, this.name))
				.remove();
		} catch (e) {
			logger.logSystemEvent(LogTypes.removeVolumeError, {
				volume: { name: this.name, appId: this.appId },
				error: e,
			});
		}
	}

	public static generateDockerName(appId: number, name: string) {
		return `${appId}_${name}`;
	}

	private static deconstructDockerName(name: string): {
		name: string;
		appId: number;
	} {
		const match = name.match(/(\d+)_(\S+)/);
		if (match == null) {
			throw new InternalInconsistencyError(
				`Could not detect volume data from docker name: ${name}`,
			);
		}

		const appId = parseInt(match[1], 10);
		if (isNaN(appId)) {
			throw new InternalInconsistencyError(
				`Could not detect application id from docker name: ${match[1]}`,
			);
		}

		return {
			appId,
			name: match[2],
		};
	}

	private static omitSupervisorLabels(labels: LabelObject): LabelObject {
		// TODO: Export these to a constant
		return omitBy(
			labels,
			(_v, k) =>
				k === 'io.resin.supervised' ||
				k === 'io.balena.supervised' ||
				// TODO: we need to omit the app-uuid label
				// in the comparison or else the supervisor will try to recreate
				// the volume, which won't fail but won't have any effect on the volume
				// either, leading to a supervisor target state apply loop
				k === 'io.balena.app-uuid',
		);
	}
}

export default Volume;
