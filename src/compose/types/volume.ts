import type { LabelObject } from '../../types';
import type { VolumeInspectInfo } from 'dockerode';
export type { ComposeVolumeConfig } from '../../types';

export interface VolumeConfig {
	labels: LabelObject;
	driver: string;
	driverOpts: VolumeInspectInfo['Options'];
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
