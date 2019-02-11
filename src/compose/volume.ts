import { VolumeInspectInfo } from 'dockerode';
import * as _ from 'lodash';

import constants = require('../lib/constants');
import Docker from '../lib/docker-utils';
import * as LogTypes from '../lib/log-types';
import Logger from '../logger';
import { sanitiseVolumeComposeConfig } from './sanitise';
import { ConfigMap } from './types/service';
import * as ComposeUtils from './utils';
import { ComparibleComposeObject } from './types/comparable';

export interface VolumeConfig {
	driver: string;
	driverOpts: Dictionary<string>;
	labels: Dictionary<string>;
}

export interface VolumeCreateOpts {
	name: string;
	appId: number;
	docker: Docker;
	logger: Logger;
}

export type VolumeConstructOpts = VolumeCreateOpts & {
	config: VolumeConfig;
};

export class Volume extends ComparibleComposeObject {
	private docker: Docker;
	private logger: Logger;

	public name: string;
	public appId: number;
	public config: VolumeConfig;

	private constructor(opts: VolumeConstructOpts) {
		super();
		this.appId = opts.appId;
		this.docker = opts.docker;
		this.logger = opts.logger;
		this.config = opts.config;

		this.name = Volume.generateName(opts.name, this.appId);

		this.config.labels = ComposeUtils.normalizeLabels(
			_.assign(this.config.labels, constants.defaultVolumeLabels),
		);
	}

	public async create(): Promise<void> {
		this.logger.logSystemEvent(LogTypes.createVolume, {
			volume: { name: this.name },
		});

		try {
			await this.docker.createVolume({
				Name: this.name,
				Labels: this.config.labels,
				Driver: this.config.driver,
				DriverOpts: this.config.driverOpts,
			});
		} catch (e) {
			this.logger.logSystemEvent(LogTypes.createVolumeError, {
				network: { name: this.name },
				error: e,
			});
			throw e;
		}
	}

	public async remove(): Promise<void> {
		this.logger.logSystemEvent(LogTypes.removeVolume, {
			volume: { name: this.name },
		});

		try {
			await this.docker.getVolume(this.name).remove();
		} catch (e) {
			this.logger.logSystemEvent(LogTypes.removeVolumeError, {
				volume: { name: this.name },
				error: e,
			});
			throw e;
		}
	}

	public isEqualConfig(volume: Volume): boolean {
		return _.isEqual(this.config, volume.config);
	}

	public static fromComposeObject(
		opts: VolumeCreateOpts,
		compose: ConfigMap,
	): Volume {
		const sanitisedConfig = sanitiseVolumeComposeConfig(
			_.mapKeys(compose, (_v, k) => _.camelCase(k)),
		);

		return new Volume(
			_.merge({}, opts, {
				config: _.defaults(sanitisedConfig, {
					driver: 'local',
					driverOpts: {},
					labels: {},
				}),
			}),
		);
	}

	public static fromDockerVolume(
		opts: VolumeCreateOpts,
		volume: VolumeInspectInfo,
	): Volume {
		const config: VolumeConfig = {
			driver: volume.Driver,
			driverOpts: volume.Options || {},
			labels: volume.Labels,
		};

		return new Volume(_.merge({}, opts, { config }));
	}

	public static generateName(name: string, appId: number): string {
		return `${appId}_${name}`;
	}

	public static splitName(nameAppId: string): { name: string; appId: number } {
		const match = nameAppId.match(/^([0-9]+)_(.+)$/);
		if (match == null) {
			throw new Error(`Could not parse volume name: ${nameAppId}`);
		}
		return {
			name: match[1],
			appId: parseInt(match[2], 10),
		};
	}
}

export default Volume;
