import { ComposeNetworkConfig } from '../compose/types/network';
import { ServiceComposeConfig } from '../compose/types/service';
import { ComposeVolumeConfig } from '../compose/volume';
import { EnvVarObject, LabelObject } from '../lib/types';

export interface DeviceApplicationState {
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
	};
	// TODO: Type the dependent entry correctly
	dependent?: any;
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
				commit: string;
				releaseId: number;
				services: {
					[serviceId: string]: {
						labels: LabelObject;
						imageId: number;
						serviceName: string;
						image: string;
						running: boolean;
						environment: EnvVarObject;
					} & ServiceComposeConfig;
				};
				volumes: Dictionary<Partial<ComposeVolumeConfig>>;
				networks: Dictionary<Partial<ComposeNetworkConfig>>;
			};
		};
	};
	// TODO: Correctly type this once dependent devices are
	// actually properly supported
	dependent: {
		apps: Dictionary<{
			name?: string;
			image?: string;
			commit?: string;
			config?: EnvVarObject;
			environment?: EnvVarObject;
		}>;
		devices: Dictionary<{
			name?: string;
			apps?: Dictionary<{
				config?: EnvVarObject;
				environment?: EnvVarObject;
			}>;
		}>;
	};
}

export type LocalTargetState = TargetState['local'];
export type TargetApplications = LocalTargetState['apps'];
export type TargetApplication = LocalTargetState['apps'][0];
export type AppsJsonFormat = Omit<TargetState['local'], 'name'> & {
	pinDevice?: boolean;
};

export type ApplicationDatabaseFormat = Array<{
	appId: number;
	commit: string;
	name: string;
	source: string;
	releaseId: number;
	services: string;
	networks: string;
	volumes: string;
}>;
