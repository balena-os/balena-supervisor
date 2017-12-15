Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
logTypes = require '../lib/log-types'
constants = require '../lib/constants'
validation = require '../lib/validation'

{ NotFoundError } = require '../lib/errors'

# image = {
# 	name: image registry/repo@digest or registry/repo:tag
# 	appId
# 	serviceId
# 	serviceName
# 	imageId (from resin API)
# 	releaseId
# 	dependent
# 	dockerImageId
# 	status Downloading, Downloaded, Deleting
# 	downloadProgress
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
			@reportChange(image.imageId, { downloadProgress: progress.percentage })

		@normalise(image.name)
		.then (imageName) =>
			image = _.clone(image)
			image.name = imageName
			@markAsSupervised(image)
			.then =>
				@inspectByName(imageName)
				.tap (img) =>
					@db.models('image').update({ dockerImageId: img.Id }).where(image)
			.catch =>
				@reportChange(image.imageId, _.merge(_.clone(image), { status: 'Downloading', downloadProgress: 0 }))
				Promise.try =>
					if validation.checkTruthy(opts.delta)
						@logger.logSystemEvent(logTypes.downloadImageDelta, { image })
						Promise.try =>
							if opts.deltaSource
								@inspectByName(opts.deltaSource)
								.then (srcImage) ->
									opts.deltaSourceId = srcImage.Id
						.then =>
							@docker.rsyncImageWithProgress(imageName, opts, onProgress)
					else
						@logger.logSystemEvent(logTypes.downloadImage, { image })
						@docker.fetchImageWithProgress(imageName, opts, onProgress)
				.then (id) =>
					@db.models('image').update({ dockerImageId: id }).where(image)
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
		image.dependent ?= 0
		image.dockerImageId ?= null
		return _.omit(image, 'id')

	markAsSupervised: (image) =>
		image = @format(image)
		@db.upsertModel('image', image, image)

	update: (image) =>
		image = @format(image)
		@db.models('image').update(image).where(name: image.name)

	save: (image) =>
		@inspectByName(image.name)
		.then (img) =>
			image = _.clone(image)
			image.dockerImageId = img.Id
			@markAsSupervised(image)

	_removeImageIfNotNeeded: (image) =>
		# We first fetch the image from the DB to ensure it exists,
		# and get the dockerImageId and any other missing field
		@db.models('image').select().where(image)
		.then (images) =>
			if images.length == 0
				return false
			img = images[0]
			Promise.try =>
				if !img.dockerImageId?
					# Legacy image from before we started using dockerImageId, so we try to remove it by name
					@docker.getImage(img.name).remove(force: true)
					.return(true)
				else
					@db.models('image').where(dockerImageId: img.dockerImageId).select()
					.then (imagesFromDB) =>
						if imagesFromDB.length == 1 and _.isEqual(@format(imagesFromDB[0]), @format(img))
							@reportChange(image.imageId, _.merge(_.clone(image), { status: 'Deleting' }))
							@logger.logSystemEvent(logTypes.deleteImage, { image })
							@docker.getImage(img.dockerImageId).remove(force: true)
							.return(true)
						else
							return false
			.catchReturn(NotFoundError, false)
			.tap =>
				@db.models('image').del().where(id: img.id)
		.then (removed) =>
			if removed
				@logger.logSystemEvent(logTypes.deleteImageSuccess, { image })
		.finally =>
			@reportChange(image.imageId)

	remove: (image) =>
		@_removeImageIfNotNeeded(image)
		.catch (err) =>
			@logger.logSystemEvent(logTypes.deleteImageError, { image, error: err })
			throw err

	getByDockerId: (id) =>
		@db.models('image').where(dockerImageId: id).first()

	removeByDockerId: (id) =>
		@getByDockerId(id)
		.then(@remove)

	getNormalisedTags: (image) ->
		Promise.map(image.RepoTags ? [], (tag) => @normalise(tag))

	_withImagesFromDockerAndDB: (callback) =>
		Promise.join(
			@docker.listImages(digests: true)
			.map (image) =>
				image.NormalisedRepoTags = @getNormalisedTags(image)
				Promise.props(image)
			@db.models('image').select()
			callback
		)

	_matchesTagOrDigest: (image, dockerImage) ->
		return _.includes(dockerImage.NormalisedRepoTags, image.name) or
			_.some(dockerImage.RepoDigests, (digest) -> Images.hasSameDigest(image.name, digest))

	_isAvailableInDocker: (image, dockerImages) =>
		_.some dockerImages, (dockerImage) =>
			@_matchesTagOrDigest(image, dockerImage) or image.dockerImageId == dockerImage.Id

	# Gets all images that are supervised, in an object containing name, appId, serviceId, serviceName, imageId, dependent.
	getAvailable: =>
		@_withImagesFromDockerAndDB (dockerImages, supervisedImages) =>
			_.filter(supervisedImages, (image) => @_isAvailableInDocker(image, dockerImages))

	cleanupDatabase: =>
		@_withImagesFromDockerAndDB (dockerImages, supervisedImages) =>
			Promise.map supervisedImages, (image) =>
				# If the supervisor was interrupted between fetching an image and storing its id,
				# some entries in the db might need to have the dockerImageId populated
				if !image.dockerImageId?
					id = _.find(dockerImages, (dockerImage) => @_matchesTagOrDigest(image, dockerImage))?.Id
					if id?
						@db.models('image').update(dockerImageId: id).where(image)
						.then ->
							image.dockerImageId = id
			.then =>
				_.filter(supervisedImages, (image) => !@_isAvailableInDocker(image, dockerImages))
		.then (imagesToRemove) =>
			ids = _.map(imagesToRemove, 'id')
			@db.models('image').del().whereIn('id', ids)

	getStatus: =>
		@getAvailable()
		.map (image) ->
			image.status = 'Downloaded'
			image.downloadProgress = null
			return image
		.then (images) =>
			status = _.clone(@volatileState)
			for image in images
				status[image.imageId] ?= image
			return _.values(status)

	_getImagesForCleanup: =>
		images = []
		Promise.join(
			@docker.getRegistryAndName(constants.supervisorImage)
			@db.models('image').select('dockerImageId')
			.map((image) -> image.dockerImageId)
			(supervisorImageInfo, usedImageIds) =>
				@docker.listImages(digests: true)
				.map (image) =>
					# Cleanup should remove truly dangling images (i.e. dangling and with no digests)
					if _.isEmpty(image.RepoTags) and _.isEmpty(image.RepoDigests) and not image.Id in usedImageIds
						images.push(image.Id)
					else if !_.isEmpty(image.RepoTags)
						# We also remove images from the supervisor repository with a different tag
						Promise.map image.RepoTags, (repoTag) =>
							@docker.getRegistryAndName(repoTag)
							.then ({ imageName, tagName }) ->
								if imageName == supervisorImageInfo.imageName and tagName != supervisorImageInfo.tagName
									images.push(image.Id)
		)
		.then(_.uniq)
		.then =>
			return _.filter images, (image) =>
				!@imageCleanupFailures[image]? or Date.now() - @imageCleanupFailures[image] > constants.imageCleanupErrorIgnoreTimeout

	inspectByName: (imageName) =>
		@docker.getImage(imageName).inspect()
		.catch NotFoundError, (err) =>
			digest = imageName.split('@')[1]
			if !digest?
				throw err
			@db.models('image').where('name', 'like', "%@#{digest}").select()
			.then (imagesFromDB) =>
				for image in imagesFromDB
					if image.dockerImageId?
						return @docker.getImage(image.dockerImageId).inspect()
				throw err


	normalise: (imageName) =>
		@docker.normaliseImageName(imageName)

	isCleanupNeeded: =>
		@_getImagesForCleanup()
		.then (imagesForCleanup) ->
			return !_.isEmpty(imagesForCleanup)

	# Delete dangling images and old supervisor images
	cleanup: =>
		@_getImagesForCleanup()
		.map (image) =>
			console.log("Cleaning up #{image}")
			@docker.getImage(image).remove(force: true)
			.then =>
				delete @imageCleanupFailures[image]
			.catch (err) =>
				@logger.logSystemMessage("Error cleaning up #{image}: #{err.message} - will ignore for 1 hour", { error: err }, 'Image cleanup error')
				@imageCleanupFailures[image] = Date.now()

	@hasSameDigest: (name1, name2) ->
		hash1 = name1.split('@')[1]
		hash2 = name2.split('@')[1]
		return hash1? and hash1 == hash2

	@isSameImage: (image1, image2) ->
		return image1.name == image2.name or Images.hasSameDigest(image1.name, image2.name)

	isSameImage: @isSameImage
