import { ConfigMap } from '../compose/types/service';
import { EnvVarObject, LabelObject } from '../lib/types';

export interface DeviceApplicationState {
	local?: DeviceApplicationLocalState;
	dependent?: DependentDeviceApplicationState;
	commit?: string;
}

export interface DeviceApplicationLocalState {
	config?: Dictionary<string>;
	apps?: {
		[appId: string]: DeviceApplicationCompositionState;
	};
}

export type ComposeService = {
	imageId: number;
	serviceName: string;
	image: string;
	running: boolean;
	environment: EnvVarObject;
	labels: LabelObject;
} & ConfigMap;

export interface DeviceApplicationCompositionState {
	name: string;
	commit: string;
	releaseId: number;
	services?: {
		[serviceId: string]: ComposeService;
	};
	networks?: {
		[name: string]: ConfigMap;
	};
	volumes?: {
		[name: string]: ConfigMap;
	};
}

// FIXME: We need to define the data that we send back seperate to
// the incoming data
export interface DeviceApplicationStateForReport {
	local?: DeviceApplicationLocalState['apps'];
	dependent: DependentDeviceApplicationState;
	commit?: string;
}

export interface DependentDeviceApplicationState {
	[appId: number]: {
		images: {
			[imageId: number]: {
				status: string;
				download_progress: number | null;
			};
		};
	};
}
