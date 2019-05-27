import * as Dockerode from 'dockerode';
import * as _ from 'lodash';

import Application from './application';

import constants = require('../lib/constants');
import { LabelObject } from '../lib/types';

export interface VolumeOptions {
	labels: LabelObject;
	driverOpts: NonNullable<Dockerode.VolumeInspectInfo['Options']>;
}

export class Volume {
	private volumeName: string;

	private constructor(
		private name: string,
		private application: Application,
		private config: VolumeOptions,
	) {
		this.volumeName = this.getName();
	}

	public static createFromCompose(
		name: string,
		application: Application,
		config: VolumeOptions,
	) {
		const newLabels = _.assign(
			_.cloneDeep(constants.defaultVolumeLabels),
			config.labels,
		);
		const newConfig = _.merge(_.cloneDeep(config), { labels: newLabels });
		return new Volume(name, application, newConfig);
	}

	public static createFromDocker(
		name: string,
		application: Application,
		inspect: Dockerode.VolumeInspectInfo,
	) {
		const config: VolumeOptions = {
			labels: {},
			driverOpts: {},
		};
		if (inspect.Labels != null) {
			_.assign(config.labels, inspect.Labels);
		}
		if (inspect.Options != null) {
			_.assign(config.driverOpts, inspect.Options);
		}

		return new Volume(name, application, config as VolumeOptions);
	}

	public async createFromPath(
		name: string,
		application: Application,
		oldPath: string,
	): Promise<Volume> {
		const volume = new Volume(name);
	}

	public isEqualConfig(volume: Volume): boolean {
		return (
			_.isEqual(this.config.driverOpts, volume.config.driverOpts) &&
			_.isEqual(this.config.labels, volume.config.labels)
		);
	}

	private getName() {
		return `${this.application.appId}_${this.name}`;
	}
}

export default Volume;
