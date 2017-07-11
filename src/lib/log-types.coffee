module.exports =
	stopApp:
		eventName: 'Application kill'
		humanName: 'Killing application'
	stopAppSuccess:
		eventName: 'Application stop'
		humanName: 'Killed application'
	stopAppNoop:
		eventName: 'Application already stopped'
		humanName: 'Application is already stopped, removing container'
	stopRemoveAppNoop:
		eventName: 'Application already stopped and container removed'
		humanName: 'Application is already stopped and the container removed'
	stopAppError:
		eventName: 'Application stop error'
		humanName: 'Failed to kill application'

	downloadApp:
		eventName: 'Application docker download'
		humanName: 'Downloading application'
	downloadAppDelta:
		eventName: 'Application delta download'
		humanName: 'Downloading delta for application'
	downloadAppSuccess:
		eventName: 'Application downloaded'
		humanName: 'Downloaded application'
	downloadAppError:
		eventName: 'Application download error'
		humanName: 'Failed to download application'

	installApp:
		eventName: 'Application install'
		humanName: 'Installing application'
	installAppSuccess:
		eventName: 'Application installed'
		humanName: 'Installed application'
	installAppError:
		eventName: 'Application install error'
		humanName: 'Failed to install application'

	deleteImageForApp:
		eventName: 'Application image removal'
		humanName: 'Deleting image for application'
	deleteImageForAppSuccess:
		eventName: 'Application image removed'
		humanName: 'Deleted image for application'
	deleteImageForAppError:
		eventName: 'Application image removal error'
		humanName: 'Failed to delete image for application'
	imageAlreadyDeleted:
		eventName: 'Image already deleted'
		humanName: 'Image already deleted for application'

	startApp:
		eventName: 'Application start'
		humanName: 'Starting application'
	startAppSuccess:
		eventName: 'Application started'
		humanName: 'Started application'
	startAppNoop:
		eventName: 'Application already running'
		humanName: 'Application is already running'
	startAppError:
		eventName: 'Application start error'
		humanName: 'Failed to start application'

	updateApp:
		eventName: 'Application update'
		humanName: 'Updating application'
	updateAppError:
		eventName: 'Application update error'
		humanName: 'Failed to update application'

	appExit:
		eventName: 'Application exit'
		humanName: 'Application exited'

	appRestart:
		eventName: 'Application restart'
		humanName: 'Restarting application'

	updateAppConfig:
		eventName: 'Application config update'
		humanName: 'Updating config for application'
	updateAppConfigSuccess:
		eventName: 'Application config updated'
		humanName: 'Updated config for application'
	updateAppConfigError:
		eventName: 'Application config update error'
		humanName: 'Failed to update config for application'
