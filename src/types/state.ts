export interface DeviceApplicationState {
	local?: DeviceApplicationLocalState;
	dependent?: DependentDeviceApplicationState;
	commit?: string;
}

export interface DeviceApplicationLocalState {
	config?: Dictionary<string>;
	apps?: {
		[appId: string]: {
			services?: {
				[serviceId: string]: {
					status: string;
					releaseId: number;
					download_progress: number | null;
				};
			};
		};
	};
}

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
