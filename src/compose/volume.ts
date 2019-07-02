import * as Docker from 'dockerode';
import assign = require('lodash/assign');
import isEqual = require('lodash/isEqual');

import constants = require('../lib/constants');
import { InternalInconsistencyError } from '../lib/errors';
import * as LogTypes from '../lib/log-types';
import { LabelObject } from '../lib/types';
import Logger from '../logger';
import * as ComposeUtils from './utils';

export interface VolumeConstructOpts {
	logger: Logger;
	docker: Docker;
}

export interface VolumeConfig {
	labels: LabelObject;
	driverOpts: Docker.VolumeInspectInfo['Options'];
}

export class Volume {
	public appId: number;
	public name: string;
	public config: VolumeConfig;

	private logger: Logger;
	private docker: Docker;

	private constructor(
		name: string,
		appId: number,
		config: VolumeConfig,
		opts: VolumeConstructOpts,
	) {
		this.name = name;
		this.appId = appId;

		this.logger = opts.logger;
		this.docker = opts.docker;
		this.config = config;
	}

	public static fromDockerVolume(
		opts: VolumeConstructOpts,
		inspect: Docker.VolumeInspectInfo,
	): Volume {
		// Convert the docker inspect to the config
		const config: VolumeConfig = {
			labels: inspect.Labels || {},
			driverOpts: inspect.Options || {},
		};

		// Detect the name and appId from the inspect data
		const { name, appId } = this.deconstructDockerName(inspect.Name);

		return new Volume(name, appId, config, opts);
	}

	public static fromComposeObject(
		name: string,
		appId: number,
		config: Partial<VolumeConfig>,
		opts: VolumeConstructOpts,
	) {
		const filledConfig: VolumeConfig = {
			driverOpts: config.driverOpts || {},
			labels: ComposeUtils.normalizeLabels(config.labels || {}),
		};

		// We only need to assign the labels here, as when we
		// get it from the daemon, they should already be there
		assign(filledConfig.labels, constants.defaultVolumeLabels);

		return new Volume(name, appId, filledConfig, opts);
	}

	public isEqualConfig(volume: Volume): boolean {
		return (
			isEqual(this.config.driverOpts, volume.config.driverOpts) &&
			isEqual(this.config.labels, volume.config.labels)
		);
	}

	public async create(): Promise<void> {
		this.logger.logSystemEvent(LogTypes.createVolume, {
			volume: { name: this.name },
		});
		await this.docker.createVolume({
			Name: Volume.generateDockerName(this.appId, this.name),
			Labels: this.config.labels,
			DriverOpts: this.config.driverOpts,
		});
	}

	public async remove(): Promise<void> {
		this.logger.logSystemEvent(LogTypes.removeVolume, {
			volume: { name: this.name },
		});

		try {
			await this.docker
				.getVolume(Volume.generateDockerName(this.appId, this.name))
				.remove();
		} catch (e) {
			this.logger.logSystemEvent(LogTypes.removeVolumeError, {
				volume: { name: this.name, appId: this.appId },
				error: e,
			});
		}
	}

	public static generateDockerName(appId: number, name: string) {
		return `${appId}_${name}`;
	}

	private static deconstructDockerName(
		name: string,
	): { name: string; appId: number } {
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
}

export default Volume;
