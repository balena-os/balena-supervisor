constants = require './constants'
DockerToolbelt = require 'docker-toolbelt'
{ DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
dockerDelta = require 'docker-delta'
_ = require 'lodash'
{ request, resumable } = require './request'
{ envArrayToObject } = require './conversions'
{ checkInt } = require './validation'

applyDelta = (imgSrc, deltaUrl, { requestTimeout, applyTimeout, resumeOpts }, onProgress) ->
	new Promise (resolve, reject) ->
		req = resumable(request, { url: deltaUrl, timeout: requestTimeout }, resumeOpts)
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
				.on('error', req.destroy.bind(req))

module.exports = class DockerUtils extends DockerToolbelt
	constructor: (opts) ->
		super(opts)
		@dockerProgress = new DockerProgress(dockerToolbelt: this)
		@supervisorTagPromise = @normaliseImageName(constants.supervisorImage)
		return this

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
		{
			deltaRequestTimeout, deltaApplyTimeout, deltaRetryCount, deltaRetryInterval,
			uuid, currentApiKey, deltaEndpoint, resinApiEndpoint,
			deltaSource, startFromEmpty = false
		} = fullDeltaOpts
		retryCount = checkInt(deltaRetryCount)
		retryInterval = checkInt(deltaRetryInterval)
		requestTimeout = checkInt(deltaRequestTimeout)
		applyTimeout = checkInt(deltaApplyTimeout)
		deltaSource = 'resin/scratch' if startFromEmpty or !deltaSource?
		# I'll leave this debug log here in case we ever wonder what delta source a device is using in production
		console.log("Using delta source #{deltaSource}")
		Promise.join @getRegistryAndName(imgDest), @getRegistryAndName(deltaSource), (dstInfo, srcInfo) ->
			tokenEndpoint = "#{resinApiEndpoint}/auth/v1/token"
			opts =
				auth:
					user: 'd_' + uuid
					pass: currentApiKey
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
					request.get("#{deltaEndpoint}/api/v2/delta?src=#{deltaSource}&dest=#{imgDest}", opts)
					.on 'response', (res) ->
						res.resume() # discard response body -- we only care about response headers
						if res.statusCode in [ 502, 504 ]
							reject(new Error('Delta server is still processing the delta, will retry'))
						else if not (300 <= res.statusCode < 400 and res.headers['location']?)
							reject(new Error("Got #{res.statusCode} when requesting image from delta server."))
						else
							deltaUrl = res.headers['location']
							if deltaSource is 'resin/scratch'
								deltaSrc = null
							else
								deltaSrc = deltaSource
							resumeOpts = { maxRetries: retryCount, retryInterval }
							resolve(applyDelta(deltaSrc, deltaUrl, { requestTimeout, applyTimeout, resumeOpts }, onProgress))
					.on 'error', reject
		.then (id) =>
			@getRepoAndTag(imgDest)
			.then ({ repo, tag }) =>
				@getImage(id).tag({ repo, tag, force: true })
		.catch dockerDelta.OutOfSyncError, (err) =>
			throw err if startFromEmpty
			console.log('Falling back to delta-from-empty')
			newOpts = _.clone(fullDeltaOpts)
			newOpts.startFromEmpty = true
			@rsyncImageWithProgress(imgDest, newOpts, onProgress)

	fetchImageWithProgress: (image, { uuid, currentApiKey }, onProgress) =>
		@getRegistryAndName(image)
		.then ({ registry, imageName, tagName }) =>
			dockerOptions =
				authconfig:
					username: 'd_' + uuid,
					password: currentApiKey,
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

	# FIXME: looks like sometimes docker doesn't include the "Gateway" property.
	# Maybe switch to just looking at the docker0 interface?
	# For now we do a hacky thing using the Subnet property...
	defaultBridgeGateway: =>
		@getNetwork('bridge').inspect()
		.then (netInfo) ->
			conf = netInfo?.IPAM?.Config?[0]
			return conf.Gateway if conf?.Gateway?
			return conf.Subnet.replace('.0/16', '.1') if _.endsWith(conf?.Subnet, '.0/16')
			return '172.17.0.1'
