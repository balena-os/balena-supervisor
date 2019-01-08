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
