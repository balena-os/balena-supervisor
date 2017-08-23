constants = require './constants'
dockerToolbelt = require 'docker-toolbelt'
{ DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
dockerDelta = require 'docker-delta'
_ = require 'lodash'
{ request, resumable } = require './request'
Lock = require 'rwlock'
{ envArrayToObject } = require './conversions'

applyDelta = (imgSrc, deltaUrl, { requestTimeout, applyTimeout, resumeOpts }, onProgress) ->
	new Promise (resolve, reject) ->
		resumable(request, { url: deltaUrl, timeout: requestTimeout }, resumeOpts)
		.on('progress', onProgress)
		.on('retry', onProgress)
		.on('error', reject)
		.on 'response', (res) ->
			if res.statusCode isnt 200
				reject(new Error("Got #{res.statusCode} when requesting delta from storage."))
			else if parseInt(res.headers['content-length']) is 0
				reject(new Error('Invalid delta URL.'))
			else
				deltaStream = dockerDelta.applyDelta(imgSrc, timeout: applyTimeout)
				res.pipe(deltaStream)
				.on('id', resolve)
				.on('error', reject)

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
		@supervisorTagPromise = @normaliseImageName(constants.supervisorImage)
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

	bestDeltaSource: (image, available) ->
		sameAppDifferentServiceImg = null
		components = image.split('/')
		available = _.orderBy(available, 'Created')
		repoTags = []
		for img in available
			for repoTag in img.NormalisedRepoTags
				repoTags.push repoTag
		# Find the most recent image of the same application
		for repoTag in repoTags
			otherComponents = repoTag.split('/')
			if otherComponents[0] == components[0]
				if otherComponents[1] == components[1]
					return repoTag[0]
				else
					sameAppDifferentServiceImg = repoTag[0]

		return sameAppDifferentServiceImg if sameAppDifferentServiceImg?
		# Otherwise we start from scratch
		return 'resin/scratch'

	# TODO: cleanup to use bestDeltaSource
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

	rsyncImageWithProgress: (imgDest, fullDeltaOpts, onProgress) =>
		{ requestTimeout, applyTimeout, retryCount, retryInterval, uuid, apiKey, startFromEmpty, deltaEndpoint, apiEndpoint } = fullDeltaOpts
		startFromEmpty ?= false
		Promise.using @readLockImages(), =>
			Promise.try =>
				if startFromEmpty
					return 'resin/scratch'
				@findSimilarImage(imgDest)
			.then (imgSrc) =>
				Promise.join @getRegistryAndName(imgDest), @getRegistryAndName(imgSrc), (dstInfo, srcInfo) ->
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
							followRedirect: false
							timeout: requestTimeout

						if b?.token?
							opts.auth =
								bearer: b.token
								sendImmediately: true
						new Promise (resolve, reject) ->
							request.get("#{deltaEndpoint}/api/v2/delta?src=#{imgSrc}&dest=#{imgDest}", opts)
							.on 'response', (res) ->
								res.resume() # discard response body -- we only care about response headers
								if res.statusCode in [ 502, 504 ]
									reject(new Error('Delta server is still processing the delta, will retry'))
								else if not (300 <= res.statusCode < 400 and res.headers['location']?)
									reject(new Error("Got #{res.statusCode} when requesting image from delta server."))
								else
									deltaUrl = res.headers['location']
									if imgSrc is 'resin/scratch'
										deltaSrc = null
									else
										deltaSrc = imgSrc
									resumeOpts = { maxRetries: retryCount, retryInterval }
									resolve(applyDelta(deltaSrc, deltaUrl, { requestTimeout, applyTimeout, resumeOpts }, onProgress))
							.on 'error', reject
			.then (id) =>
				@getRepoAndTag(imgDest)
				.then ({ repo, tag }) =>
					@getImage(id).tag({ repo, tag, force: true })
			.catch dockerDelta.OutOfSyncError, (err) =>
				console.log('Falling back to delta-from-empty')
				newOpts = _.clone(fullDeltaOpts)
				newOpts.startFromEmpty = true
				@rsyncImageWithProgress(imgDest, newOpts, onProgress)

	fetchImageWithProgress: (image, { uuid, apiKey }, onProgress) =>
		Promise.using @readLockImages(), =>
			@getRegistryAndName(image)
			.then ({ registry, imageName, tagName }) =>
				dockerOptions =
					authconfig:
						username: 'd_' + uuid,
						password: apiKey,
						serveraddress: registry
				@dockerProgress.pull(image, onProgress, dockerOptions)

	getImageEnv: (id) ->
		@getImage(id).inspect()
		.get('Config').get('Env')
		.then (env) ->
			envArrayToObject(env)
		.catch (err) ->
			console.log('Error getting env from image', err, err.stack)
			return {}

	defaultBridgeGateway: =>
		@getNetwork('bridge').inspect()
		.then (netInfo) ->
			return netInfo?.IPAM?.Config?[0]?.Gateway ? '172.17.0.1'
