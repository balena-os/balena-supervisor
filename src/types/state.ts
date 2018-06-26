export interface DeviceApplicationState {
	local: {
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
	// TODO
	dependent: any;
	commit: string;
}
