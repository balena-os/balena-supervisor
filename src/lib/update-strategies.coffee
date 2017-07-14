
module.exports = class UpdateStrategies
	constructor: (@application) ->

	'download-then-kill': ({ localApp, app, needsDownload, force }) ->
		Promise.try ->
			@application.images.fetch(app) if needsDownload
		.then ->
			Promise.using @application.lockUpdates(localApp, force), ->
				@application.logger.logSystemEvent(logTypes.updateApp, app) if localApp.imageId == app.imageId
				@application.containers.kill(localApp)
				.then ->
					@application.containers.createAndStart(app)
			.catch (err) ->
				@application.logger.logSystemEvent(logTypes.updateAppError, app, err) unless err instanceof @application.UpdatesLockedError
				throw err
	'kill-then-download': ({ localApp, app, needsDownload, force }) ->
		Promise.using lockUpdates(localApp, force), ->
			@application.logger.logSystemEvent(logTypes.updateApp, app) if localApp.imageId == app.imageId
			@application.containers.kill(localApp)
			.then ->
				fetch(app) if needsDownload
			.then ->
				@application.containers.createAndStart(app)
		.catch (err) ->
			@application.logger.logSystemEvent(logTypes.updateAppError, app, err) unless err instanceof @application.UpdatesLockedError
			throw err
	'delete-then-download': ({ localApp, app, needsDownload, force }) ->
		Promise.using lockUpdates(localApp, force), ->
			@application.logger.logSystemEvent(logTypes.updateApp, app) if localApp.imageId == app.imageId
			@application.containers.kill(localApp)
			.then (appFromDB) ->
				# If we don't need to download a new image,
				# there's no use in deleting the image
				if needsDownload
					deleteImage(appFromDB)
					.then ->
						fetch(app)
			.then ->
				@application.containers.createAndStart(app)
		.catch (err) ->
			@application.logger.logSystemEvent(logTypes.updateAppError, app, err) unless err instanceof @application.UpdatesLockedError
			throw err
	'hand-over': ({ localApp, app, needsDownload, force, timeout }) ->
		Promise.using lockUpdates(localApp, force), ->
			utils.getKnexApp(localApp.appId)
			.then (localApp) ->
				Promise.try ->
					fetch(app) if needsDownload
				.then ->
					@application.logger.logSystemEvent(logTypes.updateApp, app) if localApp.imageId == app.imageId
					@application.containers.createAndStart(app)
				.then ->
					waitToKill(localApp, timeout)
				.then ->
					@application.containers.kill(localApp)
		.catch (err) ->
			@application.logger.logSystemEvent(logTypes.updateAppError, app, err) unless err instanceof @application.UpdatesLockedError
			throw err
