// TODO: move all these exported types to ../compose/types
import { ComposeNetworkConfig } from '../compose/types/network';
import { ServiceComposeConfig } from '../compose/types/service';
import { ComposeVolumeConfig } from '../compose/volume';

import { EnvVarObject, LabelObject } from './basic';

import App from '../compose/app';

export type DeviceReportFields = Partial<{
	api_port: number;
	api_secret: string | null;
	ip_address: string;
	os_version: string | null;
	os_variant: string | null;
	supervisor_version: string;
	provisioning_progress: null | number;
	provisioning_state: string;
	status: string;
	update_failed: boolean;
	update_pending: boolean;
	update_downloaded: boolean;
	is_on__commit: string;
	logs_channel: null;
	mac_address: string | null;
}>;

// This is the state that is sent to the cloud
export interface DeviceStatus {
	local?: {
		config?: Dictionary<string>;
		apps?: {
			[appId: string]: {
				services: {
					[serviceId: string]: {
						status: string;
						releaseId: number;
						download_progress: number | null;
					};
				};
			};
		};
	} & DeviceReportFields;
	// TODO: Type the dependent entry correctly
	dependent?: {
		[key: string]: any;
	};
	commit?: string;
}

// TODO: Define this with io-ts so we can perform validation
// on the target state from the api, local mode, and preload
export interface TargetState {
	local: {
		name: string;
		config: EnvVarObject;
		apps: {
			[appId: string]: {
				name: string;
				commit?: string;
				releaseId?: number;
				services: {
					[serviceId: string]: {
						labels: LabelObject;
						imageId: number;
						serviceName: string;
						image: string;
						running?: boolean;
						environment: Dictionary<string>;
						contract?: Dictionary<any>;
					} & ServiceComposeConfig;
				};
				volumes: Dictionary<Partial<ComposeVolumeConfig>>;
				networks: Dictionary<Partial<ComposeNetworkConfig>>;
			};
		};
	};
	dependent: {
		apps: {
			[appId: string]: {
				name: string;
				parentApp: number;
				config: EnvVarObject;
				releaseId?: number;
				imageId?: number;
				commit?: string;
				image?: string;
			};
		};
		devices: {
			[uuid: string]: {
				name: string;
				apps: {
					[id: string]: {
						config: EnvVarObject;
						environment: EnvVarObject;
					};
				};
			};
		};
	};
}

export type LocalTargetState = TargetState['local'];
export type TargetApplications = LocalTargetState['apps'];
export type TargetApplication = LocalTargetState['apps'][0];
export type TargetApplicationService = TargetApplication['services'][0];
export type AppsJsonFormat = Omit<TargetState['local'], 'name'> & {
	pinDevice?: boolean;
	apps: {
		// The releaseId/commit are required for preloading
		[id: string]: Required<TargetState['local']['apps'][string]>;
	};
};

export type InstancedAppState = { [appId: number]: App };

export interface InstancedDeviceState {
	local: {
		name: string;
		config: Dictionary<string>;
		apps: InstancedAppState;
	};
	dependent: any;
}
