Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
logTypes = require '../lib/log-types'
constants = require '../lib/constants'
validation = require '../lib/validation'

ImageNotFoundError = (err) ->
	return "#{err.statusCode}" is '404'

# image = {
# 	name: image registry/repo:tag
# 	appId
# 	serviceId
# 	serviceName
# 	imageId (from resin API)
# 	releaseId
# 	dependent
# 	status Downloading, Downloaded, Deleting
# 	download_progress
# }

module.exports = class Images extends EventEmitter
	constructor: ({ @docker, @logger, @db }) ->
		@imageCleanupFailures = {}
		# A store of volatile state for images (e.g. download progress), indexed by imageId
		@volatileState = {}

	reportChange: (imageId, status) ->
		if status?
			@volatileState[imageId] ?= { imageId }
			_.merge(@volatileState[imageId], status)
			@emit('change')
		else if imageId? and @volatileState[imageId]?
			delete @volatileState[imageId]
			@emit('change')

	fetch: (image, opts) =>
		onProgress = (progress) =>
			@reportChange(image.imageId, { download_progress: progress.percentage })

		@normalise(image.name)
		.then (imageName) =>
			image = _.clone(image)
			image.name = imageName
			@markAsSupervised(image)
			.then =>
				@inspectByName(imageName)
			.catch =>
				@reportChange(image.imageId, _.merge(_.clone(image), { status: 'Downloading', download_progress: 0 }))
				Promise.try =>
					if validation.checkTruthy(opts.delta)
						@logger.logSystemEvent(logTypes.downloadImageDelta, { image })
						@docker.rsyncImageWithProgress(imageName, opts, onProgress)
					else
						@logger.logSystemEvent(logTypes.downloadImage, { image })
						@docker.fetchImageWithProgress(imageName, opts, onProgress)
				.then =>
					@logger.logSystemEvent(logTypes.downloadImageSuccess, { image })
					@inspectByName(imageName)
				.catch (err) =>
					@logger.logSystemEvent(logTypes.downloadImageError, { image, error: err })
					throw err
				.finally =>
					@reportChange(image.imageId)

	format: (image) ->
		image.serviceId ?= null
		image.serviceName ?= null
		image.imageId ?= null
		image.releaseId ?= null
		image.dependent ?= false
		return _.omit(image, 'id')

	markAsSupervised: (image) =>
		image = @format(image)
		@db.upsertModel('image', image, image)

	update: (image) =>
		image = @format(image)
		@db.models('image').update(image).where(name: image.name)

	_removeImageIfNotNeeded: (image) =>
		removed = true
		@inspectByName(image.name)
		.catch ImageNotFoundError, (err) ->
			removed = false
			return null
		.then (img) =>
			if img?
				@db.models('image').where(name: image.name).select()
				.then (imagesFromDB) =>
					if imagesFromDB.length == 1 and _.isEqual(@format(imagesFromDB[0]), @format(image))
						@docker.getImage(image.name).remove(force: true)
		.then ->
			return removed

	remove: (image) =>
		@reportChange(image.imageId, _.merge(_.clone(image), { status: 'Deleting' }))
		@logger.logSystemEvent(logTypes.deleteImage, { image })
		@_removeImageIfNotNeeded(image)
		.tap =>
			@db.models('image').del().where(image)
		.then (removed) =>
			if removed
				@logger.logSystemEvent(logTypes.deleteImageSuccess, { image })
			else
				@logger.logSystemEvent(logTypes.imageAlreadyDeleted, { image })
		.catch (err) =>
			@logger.logSystemEvent(logTypes.deleteImageError, { image, error: err })
			throw err
		.finally =>
			@reportChange(image.imageId)

	getNormalisedTags: (image) ->
		Promise.map(image.RepoTags ? [], (tag) => @normalise(tag))

	_withImagesFromDockerAndDB: (callback) =>
		Promise.join(
			@docker.listImages()
			.map (image) =>
				image.NormalisedRepoTags = @getNormalisedTags(image)
				Promise.props(image)
			@db.models('image').select()
			callback
		)

	_isAvailableInDocker: (image, dockerImages) ->
		_.some dockerImages, (dockerImage) ->
			_.includes(dockerImage.NormalisedRepoTags, image.name)

	# Gets all images that are supervised, in an object containing name, appId, serviceId, serviceName, imageId, dependent.
	getAvailable: =>
		@_withImagesFromDockerAndDB (dockerImages, supervisedImages) =>
			return _.filter(supervisedImages, (image) => @_isAvailableInDocker(image, dockerImages))

	cleanupDatabase: =>
		@_withImagesFromDockerAndDB (dockerImages, supervisedImages) =>
			return _.filter(supervisedImages, (image) => !@_isAvailableInDocker(image, dockerImages))
		.then (imagesToRemove) =>
			ids = _.map(imagesToRemove, 'id')
			@db.models('image').del().whereIn('id', ids)

	getStatus: =>
		@getAvailable()
		.map (image) ->
			image.status = 'Downloaded'
			image.download_progress = null
			return image
		.then (images) =>
			status = _.clone(@volatileState)
			_.forEach images, (image) ->
				status[image.imageId] ?= image
			return _.values(status)

	_getDanglingAndOldSupervisorsForCleanup: =>
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

	inspectByName: (imageName) =>
		@docker.getImage(imageName).inspect()

	normalise: (imageName) =>
		@docker.normaliseImageName(imageName)

	isCleanupNeeded: =>
		@_getDanglingAndOldSupervisorsForCleanup()
		.then (imagesForCleanup) ->
			return !_.isEmpty(imagesForCleanup)

	# Delete old supervisor images and dangling images
	cleanup: =>
		@_getDanglingAndOldSupervisorsForCleanup()
		.map (image) =>
			@docker.getImage(image).remove(force: true)
			.then =>
				delete @imageCleanupFailures[image]
			.catch (err) =>
				@logger.logSystemMessage("Error cleaning up #{image}: #{err.message} - will ignore for 1 hour", { error: err }, 'Image cleanup error')
				@imageCleanupFailures[image] = Date.now()
