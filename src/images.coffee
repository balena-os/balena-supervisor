Promise = require 'bluebird'
logTypes = require './lib/log-types'

ImageNotFoundError = (err) ->
	return "#{err.statusCode}" is '404'

module.exports = class Images
	constructor: ({ @docker, @logger, @deviceState }) ->

	fetch: (image, app = {}, opts) ->
		onProgress = (progress) =>
			@deviceState.reportCurrent(download_progress: progress.percentage)

		@docker.getImage(image).inspect()
		.catch (error) ->
			@deviceState.reportCurrent(status: 'Downloading', download_progress: 0)
			Promise.try =>
				if opts.delta
					@logger.logSystemEvent(logTypes.downloadAppDelta, app)
					requestTimeout = opts.deltaRequestTimeout # checkInt(conf['RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT'], positive: true) ? 30 * 60 * 1000
					totalTimeout = opts.deltaTotalTimeout # checkInt(conf['RESIN_SUPERVISOR_DELTA_TOTAL_TIMEOUT'], positive: true) ? 24 * 60 * 60 * 1000
					{ uuid, apiKey, apiEndpoint, deltaEndpoint } = opts
					@docker.rsyncImageWithProgress(image, { requestTimeout, totalTimeout, uuid, apiKey, apiEndpoint, deltaEndpoint }, onProgress)
				else
					@logger.logSystemEvent(logTypes.downloadApp, app)
					{ uuid, apiKey } = opts
					@docker.fetchImageWithProgress(image, onProgress, { uuid, apiKey })
			.then =>
				@logger.logSystemEvent(logTypes.downloadAppSuccess, app)

				@deviceState.reportCurrent(status: 'Idle', download_progress: null)
				@docker.getImage(image).inspect()
			.catch (err) =>
				@logger.logSystemEvent(logTypes.downloadAppError, app, err)
				throw err

	remove: (image, app) ->
		@logger.logSystemEvent(logTypes.deleteImageForApp, app)
		@docker.getImage(image).removeAsync(force: true)
		.then =>
			@logger.logSystemEvent(logTypes.deleteImageForAppSuccess, app)
		.catch ImageNotFoundError, (err) =>
			@logger.logSystemEvent(logTypes.imageAlreadyDeleted, app)
		.catch (err) =>
			@logger.logSystemEvent(logTypes.deleteImageForAppError, app, err)
			throw err