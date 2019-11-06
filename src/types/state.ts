import { ComposeNetworkConfig } from '../compose/types/network';
import { ServiceComposeConfig } from '../compose/types/service';
import { ComposeVolumeConfig } from '../compose/volume';

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
		config: Dictionary<string>;
		apps: {
			[appId: string]: {
				name: string;
				commit: string;
				releaseId: number;
				services: {
					[serviceId: string]: {
						labels: Dictionary<string>;
						imageId: number;
						serviceName: string;
						image: string;
						running: boolean;
						environment: Dictionary<string>;
					} & ServiceComposeConfig;
				};
				volumes: Dictionary<Partial<ComposeVolumeConfig>>;
				networks: Dictionary<Partial<ComposeNetworkConfig>>;
			};
		};
	};
	// TODO: Correctly type this once dependent devices are
	// actually properly supported
	dependent: Dictionary<any>;
}

export type LocalTargetState = TargetState['local'];
export type TargetApplications = LocalTargetState['apps'];
export type TargetApplication = LocalTargetState['apps'][0];
export type AppsJsonFormat = Omit<TargetState['local'], 'name'> & {
	pinDevice?: boolean;
};
