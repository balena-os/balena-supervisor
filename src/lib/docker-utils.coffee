constants = require './constants'
dockerToolbelt = require 'docker-toolbelt'
{ DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
progress = require 'request-progress'
dockerDelta = require 'docker-delta'
_ = require 'lodash'
{ request } = require './request'
Lock = require 'rwlock'

module.exports = class DockerUtils extends dockerToolbelt
	constructor: (opts) ->
		super(opts)
		@dockerProgress = new DockerProgress(dockerToolbelt: this)
		_lock = new Lock()
		_writeLock = Promise.promisify(_lock.async.writeLock)
		_readLock = Promise.promisify(_lock.async.readLock)
		@writeLockImages = ->
			_writeLock('images')
			.disposer (release) ->
				release()
		@readLockImages = ->
			_readLock('images')
			.disposer (release) ->
				release()
		@supervisorTagPromise = normalizeRepoTag(constants.supervisorImage)
		return this

	# Create an array of (repoTag, image_id, created) tuples like the output of `docker images`
	listRepoTags: =>
		@listImages()
		.then (images) ->
			images = _.orderBy(images, 'Created', [ false ])
			ret = []
			for image in images
				for repoTag in image.RepoTags
					ret.push [ repoTag, image.Id, image.Created ]
			return ret

	# Find either the most recent image of the same app or the image of the supervisor.
	# Returns an image Id or Tag (depending on whatever's available)
	findSimilarImage: (repoTag) =>
		application = repoTag.split('/')[1]

		@listRepoTags()
		.then (repoTags) ->
			# Find the most recent image of the same application
			for repoTag in repoTags
				otherApplication = repoTag[0].split('/')[1]
				if otherApplication is application
					return repoTag[0]

			# Otherwise we start from scratch
			return 'resin/scratch'

	getRepoAndTag: (image) =>
		@getRegistryAndName(image)
		.then ({ registry, imageName, tagName }) ->
			if registry?
				registry = registry.toString().replace(':443', '')
				repoName = "#{registry}/#{imageName}"
			else
				repoName = imageName
			return { repo: repoName, tag: tagName }

	
	rsyncImageWithProgress: (imgDest, { requestTimeout, totalTimeout, uuid, apiKey, startFromEmpty = false, deltaEndpoint, apiEndpoint }, onProgress) ->
		Promise.using @readLockImages(), =>
			Promise.try =>
				if startFromEmpty
					return 'resin/scratch'
				@findSimilarImage(imgDest)
			.then (imgSrc) =>
				Promise.join @getRegistryAndName(imgDest), @getRegistryAndName(imgSrc), (dstInfo, srcInfo) =>
					tokenEndpoint = "#{apiEndpoint}/auth/v1/token"
					opts =
						auth:
							user: 'd_' + uuid
							pass: apiKey
							sendImmediately: true
						json: true
						timeout: requestTimeout
					url = "#{tokenEndpoint}?service=#{dstInfo.registry}&scope=repository:#{dstInfo.imageName}:pull&scope=repository:#{srcInfo.imageName}:pull"
					request.getAsync(url, opts)
					.get(1)
					.then (b) ->
						opts =
							timeout: requestTimeout

						if b?.token?
							deltaAuthOpts =
								auth:
									bearer: b?.token
									sendImmediately: true
							opts = _.merge(opts, deltaAuthOpts)
						new Promise (resolve, reject) ->
							progress request.get("#{deltaEndpoint}/api/v2/delta?src=#{imgSrc}&dest=#{imgDest}", opts)
							.on 'progress', (progress) ->
								# In request-progress ^2.0.1, "percentage" is a ratio from 0 to 1
								onProgress(percentage: progress.percentage * 100)
							.on 'end', ->
								onProgress(percentage: 100)
							.on 'response', (res) ->
								if res.statusCode is 504
									reject(new Error('Delta server is still processing the delta, will retry'))
								else if res.statusCode isnt 200
									reject(new Error("Got #{res.statusCode} when requesting image from delta server."))
								else
									if imgSrc is 'resin/scratch'
										deltaSrc = null
									else
										deltaSrc = imgSrc
									res.pipe(dockerDelta.applyDelta(deltaSrc, imgDest))
									.on('id', resolve)
									.on('error', reject)
							.on 'error', reject
				.timeout(totalTimeout)
			.then (id) =>
				@getRepoAndTag(imgDest)
				.then ({ repo, tag }) =>
					@getImage(id).tag({ repo, tag, force: true })
			.catch dockerDelta.OutOfSyncError, (err) =>
				console.log('Falling back to delta-from-empty')
				@rsyncImageWithProgress(imgDest, { requestTimeout, totalTimeout, uuid, apiKey, startFromEmpty: true }, onProgress)

	fetchImageWithProgress: (image, onProgress, { uuid, apiKey }) =>
		Promise.using @readLockImages(), =>
			@getRegistryAndName(image)
			.then ({ registry, imageName, tagName }) =>
				dockerOptions =
					authconfig:
						username: 'd_' + uuid,
						password: apiKey,
						serveraddress: registry
				@dockerProgress.pull(image, onProgress, dockerOptions)

	normalizeRepoTag: (image) =>
		@getRepoAndTag(image)
		.then ({ repo, tag }) ->
			@buildRepoTag(repo, tag)

	

	# Todo: cleanup so it doesn't look in knex and receives what images to clean up/protect
	cleanupContainersAndImages: (extraImagesToIgnore = []) ->
		Promise.using writeLockImages(), ->
			Promise.join(
				knex('app').select()
				.map ({ imageId }) ->
					normalizeRepoTag(imageId)
				knex('dependentApp').select().whereNotNull('imageId')
				.map ({ imageId }) ->
					normalizeRepoTag(imageId)
				supervisorTagPromise
				docker.listImages()
				.map (image) ->
					image.NormalizedRepoTags = Promise.map(image.RepoTags, normalizeRepoTag)
					Promise.props(image)
				Promise.map(extraImagesToIgnore, normalizeRepoTag)
				(apps, dependentApps, supervisorTag, images, normalizedExtraImages) ->
					imageTags = _.map(images, 'NormalizedRepoTags')
					supervisorTags = _.filter imageTags, (tags) ->
						_.includes(tags, supervisorTag)
					appTags = _.filter imageTags, (tags) ->
						_.some tags, (tag) ->
							_.includes(apps, tag) or _.includes(dependentApps, tag)
					extraTags = _.filter imageTags, (tags) ->
						_.some tags, (tag) ->
							_.includes(normalizedExtraImages, tag)
					supervisorTags = _.flatten(supervisorTags)
					appTags = _.flatten(appTags)
					extraTags = _.flatten(extraTags)

					return { images, supervisorTags, appTags, extraTags }
			)
			.then ({ images, supervisorTags, appTags, extraTags }) ->
				# Cleanup containers first, so that they don't block image removal.
				docker.listContainers(all: true)
				.filter (containerInfo) ->
					# Do not remove user apps.
					normalizeRepoTag(containerInfo.Image)
					.then (repoTag) ->
						if _.includes(appTags, repoTag)
							return false
						if _.includes(extraTags, repoTag)
							return false
						if !_.includes(supervisorTags, repoTag)
							return true
						return containerHasExited(containerInfo.Id)
				.map (containerInfo) ->
					docker.getContainer(containerInfo.Id).remove(v: true, force: true)
					.then ->
						console.log('Deleted container:', containerInfo.Id, containerInfo.Image)
					.catch(_.noop)
				.then ->
					imagesToClean = _.reject images, (image) ->
						_.some image.NormalizedRepoTags, (tag) ->
							return _.includes(appTags, tag) or _.includes(supervisorTags, tag) or _.includes(extraTags, tag)
					Promise.map imagesToClean, (image) ->
						Promise.map image.RepoTags.concat(image.Id), (tag) ->
							docker.getImage(tag).remove(force: true)
							.then ->
								console.log('Deleted image:', tag, image.Id, image.RepoTags)
							.catch(_.noop)

	containerHasExited: (id) =>
		@getContainer(id).inspect()
		.then (data) ->
			return not data.State.Running

	buildRepoTag: (repo, tag, registry) ->
		repoTag = ''
		if registry?
			repoTag += registry + '/'
		repoTag += repo
		if tag?
			repoTag += ':' + tag
		else
			repoTag += ':latest'
		return repoTag

	getImageEnv: (id) ->
		@getImage(id).inspect()
		.get('Config').get('Env')
		.then (env) ->
			# env is an array of strings that say 'key=value'
			_(env)
			.invokeMap('split', '=')
			.fromPairs()
			.value()
		.catch (err) ->
			console.log('Error getting env from image', err, err.stack)
			return {}
