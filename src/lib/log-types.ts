export const stopService= {
	eventName: 'Service kill',
	humanName: 'Killing service',
};
export const stopServiceSuccess= {
	eventName: 'Service stop',
	humanName: 'Killed service',
};
export const stopServiceNoop = {
	eventName: 'Service already stopped',
	humanName: 'Service is already stopped, removing container',
};
export const stopRemoveServiceNoop = {
	eventName: 'Service already stopped and container removed',
	humanName: 'Service is already stopped and the container removed',
};
export const stopServiceError = {
	eventName: 'Service stop error',
	humanName: 'Failed to kill service',
};

export const removeDeadService = {
	eventName: 'Remove dead container',
	humanName: 'Removing dead container',
};
export const removeDeadServiceError = {
	eventName: 'Remove dead container error',
	humanName: 'Error removing dead container',
};

export const downloadImage = {
	eventName: 'Docker image download',
	humanName: 'Downloading image',
};
export const downloadImageDelta = {
	eventName: 'Delta image download',
	humanName: 'Downloading delta for image',
};
export const downloadImageSuccess = {
	eventName: 'Image downloaded',
	humanName: 'Downloaded image',
};
export const downloadImageError = {
	eventName: 'Image download error',
	humanName: 'Failed to download image',
};

export const installService = {
	eventName: 'Service install',
	humanName: 'Installing service',
};
export const installServiceSuccess = {
	eventName: 'Service installed',
	humanName: 'Installed service',
};
export const installServiceError = {
	eventName: 'Service install error',
	humanName: 'Failed to install service',
};

export const deleteImage = {
	eventName: 'Image removal',
	humanName: 'Deleting image',
};
export const deleteImageSuccess = {
	eventName: 'Image removed',
	humanName: 'Deleted image',
};
export const deleteImageError = {
	eventName: 'Image removal error',
	humanName: 'Failed to delete image',
};
export const imageAlreadyDeleted = {
	eventName: 'Image already deleted',
	humanName: 'Image already deleted',
};
export const deltaStillProcessingError = {
	eventName: 'Delta still processing remotely.',
	humanName: 'Delta still processing remotely. Will retry...',
};

export const startService = {
	eventName: 'Service start',
	humanName: 'Starting service',
};
export const startServiceSuccess = {
	eventName: 'Service started',
	humanName: 'Started service',
};
export const startServiceNoop = {
	eventName: 'Service already running',
	humanName: 'Service is already running',
};
export const startServiceError = {
	eventName: 'Service start error',
	humanName: 'Failed to start service',
};

export const updateService = {
	eventName: 'Service update',
	humanName: 'Updating service',
};
export const updateServiceError = {
	eventName: 'Service update error',
	humanName: 'Failed to update service',
};

export const serviceExit = {
	eventName: 'Service exit',
	humanName: 'Service exited',
};

export const serviceRestart = {
	eventName: 'Service restart',
	humanName: 'Restarting service',
};

export const updateServiceConfig = {
	eventName: 'Service config update',
	humanName: 'Updating config for service',
};
export const updateServiceConfigSuccess = {
	eventName: 'Service config updated',
	humanName: 'Updated config for service',
};
export const updateServiceConfigError = {
	eventName: 'Service config update error',
	humanName: 'Failed to update config for service',
};

export const createVolume = {
	eventName: 'Volume creation',
	humanName: 'Creating volume',
};

export const createVolumeError = {
	eventName: 'Volume creation error',
	humanName: 'Error creating volume',
};

export const removeVolume = {
	eventName: 'Volume removal',
	humanName: 'Removing volume',
};

export const removeVolumeError = {
	eventName: 'Volume removal error',
	humanName: 'Error removing volume',
};

export const createNetwork = {
	eventName: 'Network creation',
	humanName: 'Creating network',
};

export const createNetworkError = {
	eventName: 'Network creation error',
	humanName: 'Error creating network',
};

export const removeNetwork = {
	eventName: 'Network removal',
	humanName: 'Removing network',
};

export const removeNetworkError = {
	eventName: 'Network removal error',
	humanName: 'Error removing network',
};
