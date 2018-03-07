module.exports =
	stopService:
		eventName: 'Service kill'
		humanName: 'Killing service'
	stopServiceSuccess:
		eventName: 'Service stop'
		humanName: 'Killed service'
	stopServiceNoop:
		eventName: 'Service already stopped'
		humanName: 'Service is already stopped, removing container'
	stopRemoveServiceNoop:
		eventName: 'Service already stopped and container removed'
		humanName: 'Service is already stopped and the container removed'
	stopServiceError:
		eventName: 'Service stop error'
		humanName: 'Failed to kill service'

	downloadImage:
		eventName: 'Docker image download'
		humanName: 'Downloading image'
	downloadImageDelta:
		eventName: 'Delta image download'
		humanName: 'Downloading delta for image'
	downloadImageSuccess:
		eventName: 'Image downloaded'
		humanName: 'Downloaded image'
	downloadImageError:
		eventName: 'Image download error'
		humanName: 'Failed to download image'

	installService:
		eventName: 'Service install'
		humanName: 'Installing service'
	installServiceSuccess:
		eventName: 'Service installed'
		humanName: 'Installed service'
	installServiceError:
		eventName: 'Service install error'
		humanName: 'Failed to install service'

	deleteImage:
		eventName: 'Image removal'
		humanName: 'Deleting image'
	deleteImageSuccess:
		eventName: 'Image removed'
		humanName: 'Deleted image'
	deleteImageError:
		eventName: 'Image removal error'
		humanName: 'Failed to delete image'
	imageAlreadyDeleted:
		eventName: 'Image already deleted'
		humanName: 'Image already deleted'

	startService:
		eventName: 'Service start'
		humanName: 'Starting service'
	startServiceSuccess:
		eventName: 'Service started'
		humanName: 'Started service'
	startServiceNoop:
		eventName: 'Service already running'
		humanName: 'Service is already running'
	startServiceError:
		eventName: 'Service start error'
		humanName: 'Failed to start service'

	updateService:
		eventName: 'Service update'
		humanName: 'Updating service'
	updateServiceError:
		eventName: 'Service update error'
		humanName: 'Failed to update service'

	serviceExit:
		eventName: 'Service exit'
		humanName: 'Service exited'

	serviceRestart:
		eventName: 'Service restart'
		humanName: 'Restarting service'

	updateServiceConfig:
		eventName: 'Service config update'
		humanName: 'Updating config for service'
	updateServiceConfigSuccess:
		eventName: 'Service config updated'
		humanName: 'Updated config for service'
	updateServiceConfigError:
		eventName: 'Service config update error'
		humanName: 'Failed to update config for service'

	createVolume:
		eventName: 'Volume creation'
		humanName: 'Creating volume'

	createVolumeError:
		eventName: 'Volume creation error'
		humanName: 'Error creating volume'

	removeVolume:
		eventName: 'Volume removal'
		humanName: 'Removing volume'

	removeVolumeError:
		eventName: 'Volume removal error'
		humanName: 'Error removing volume'

	createNetwork:
		eventName: 'Network creation'
		humanName: 'Creating network'

	createNetworkError:
		eventName: 'Network creation error'
		humanName: 'Error creating network'

	removeNetwork:
		eventName: 'Network removal'
		humanName: 'Removing network'

	removeNetworkError:
		eventName: 'Network removal error'
		humanName: 'Error removing network'
