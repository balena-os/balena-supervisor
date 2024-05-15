import type { LabelObject } from '../../types';
import type { VolumeInspectInfo } from 'dockerode';

export interface VolumeConfig {
	labels: LabelObject;
	driver: string;
	driverOpts: VolumeInspectInfo['Options'];
}

export interface ComposeVolumeConfig {
	driver: string;
	driver_opts: Dictionary<string>;
	labels: LabelObject;
}

export interface Volume {
	name: string;
	appId: number;
	appUuid: string;
	config: VolumeConfig;

	isEqualConfig(volume: Volume): boolean;
	create(): Promise<void>;
	remove(): Promise<void>;
}
