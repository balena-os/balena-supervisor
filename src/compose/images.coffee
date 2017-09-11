Promise = require 'bluebird'
_ = require 'lodash'
logTypes = require '../lib/log-types'
constants = require '../lib/constants'

ImageNotFoundError = (err) ->
	return "#{err.statusCode}" is '404'

module.exports = class Images
	constructor: ({ @docker, @logger, @db }) ->
		@imageCleanupFailures = {}

	fetch: (imageName, opts) =>
		onProgress = (progress) ->
			opts.progressReportFn?({ download_progress: progress.percentage })

		@normalise(imageName)
		.then (image) =>
			@markAsSupervised(image)
			.then =>
				@get(image)
			.catch (error) =>
				Promise.try =>
					if opts.delta
						@logger.logSystemEvent(logTypes.downloadImageDelta, { image })
						@docker.rsyncImageWithProgress(image, opts, onProgress)
					else
						@logger.logSystemEvent(logTypes.downloadImage, { image })
						@docker.fetchImageWithProgress(image, opts, onProgress)
				.then =>
					@logger.logSystemEvent(logTypes.downloadImageSuccess, { image })
					opts.progressReportFn?({ status: 'Idle', download_progress: null })
					@docker.getImage(image).inspect()
				.catch (err) =>
					@logger.logSystemEvent(logTypes.downloadImageError, { image, error: err })
					throw err

	markAsSupervised: (image) =>
		@db.upsertModel('image', { image }, { image })

	_removeImage: (image) =>
		@logger.logSystemEvent(logTypes.deleteImage, { image })
		@docker.getImage(image).remove(force: true)
		.then =>
			@db.models('image').del().where({ image })
		.then =>
			@logger.logSystemEvent(logTypes.deleteImageSuccess, { image })
		.catch ImageNotFoundError, (err) =>
			@logger.logSystemEvent(logTypes.imageAlreadyDeleted, { image })
		.catch (err) =>
			@logger.logSystemEvent(logTypes.deleteImageError, { image, error: err })
			throw err

	removeByName: (imageName) =>
		@normalise(imageName)
		.then (image) =>
			@_removeImage(image)

	remove: (image) =>
		@getNormalisedTags(image)
		.then (normalisedTags) =>
			removedTag = false
			Promise.map normalisedTags ? [], (tag) =>
				@db.models('image').where({ image: tag }).select()
				.then ([ img ]) =>
					if img?
						removedTag = true
						@removeByName(tag)
			.then =>
				if !removedTag
					@_removeImage(image.Id)

	# Used when normalising after an update, marks all current docker images except the supervisor as supervised
	superviseAll: =>
		@normalise(constants.supervisorImage)
		.then (normalisedSupervisorTag) =>
			@docker.listImages()
			.map (image) =>
				image.NormalisedRepoTags = @getNormalisedTags(image)
				Promise.props(image)
			.map (image) =>
				if !_.includes(image.NormalisedRepoTags, normalisedSupervisorTag)
					Promise.map image.NormalisedRepoTags, (tag) =>
						@markAsSupervised(tag)

	getNormalisedTags: (image) ->
		Promise.map(image.RepoTags ? [], (tag) => @normalise(tag))

	getAll: =>
		Promise.join(
			@docker.listImages()
			.map (image) =>
				image.NormalisedRepoTags = @getNormalisedTags(image)
				Promise.props(image)
			@db.models('image').select()
			.then (supervisedImages) ->
				_.map(supervisedImages, 'image')
			(images, supervisedImages) ->
				return _.filter images, (image) ->
					_.some image.NormalisedRepoTags, (tag) ->
						_.includes(supervisedImages, tag)
		)

	getDanglingAndOldSupervisorsForCleanup: =>
		images = []
		@docker.getRegistryAndName(constants.supervisorImage)
		.then (supervisorImageInfo) =>
			@docker.listImages()
			.map (image) =>
				Promise.map image.RepoTags ? [], (repoTag) =>
					@docker.getRegistryAndName(repoTag)
					.then ({ imageName, tagName }) ->
						if imageName == supervisorImageInfo.imageName and tagName != supervisorImageInfo.tagName
							images.push(repoTag)
		.then =>
			@docker.listImages(filters: { dangling: [ 'true' ] })
			.map (image) ->
				images.push(image.Id)
		.then =>
			return _.filter images, (image) =>
				!@imageCleanupFailures[image]? or Date.now() - @imageCleanupFailures[image] > 3600 * 1000

	get: (image) =>
		@docker.getImage(image).inspect()

	normalise: (image) =>
		@docker.normaliseImageName(image)

	cleanupOld: (protectedImages) =>
		Promise.join(
			@getAll()
			Promise.map(protectedImages, (image) => @normalise(image))
			(images, normalisedProtectedImages) ->
				return _.reject images, (image) ->
					_.some image.NormalisedRepoTags, (tag) ->
						_.includes(normalisedProtectedImages, tag)
		)
		.then (imagesToClean) =>
			Promise.map imagesToClean, (image) =>
				Promise.map image.RepoTags.concat(image.Id), (tag) =>
					@getImage(tag).remove()
					.then =>
						@db.models('image').del().where({ image: tag })
					.then ->
						console.log('Deleted image:', tag, image.Id, image.RepoTags)
					.catch(_.noop)

	# Delete old supervisor images and dangling images
	cleanup: =>
		@getDanglingAndOldSupervisorsForCleanup()
		.map (image) =>
			@docker.getImage(image).remove(force: true)
			.then =>
				delete @imageCleanupFailures[image]
			.catch (err) =>
				@logger.logSystemMessage("Error cleaning up #{image}: #{err.message} - will ignore for 1 hour", { error: err }, 'Image cleanup error')
				@imageCleanupFailures[image] = Date.now()


	ensureNormalised: (image) ->
		image.NormalisedRepoTags ?= @getNormalisedTags(image)
		return Promise.props(image)

	hasTag: (image, tag) ->
		@ensureNormalised(image)
		.then (image) ->
			_.includes(image.NormalisedRepoTags, image)
