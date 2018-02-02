constants = require './constants'
DockerToolbelt = require 'docker-toolbelt'
{ DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
dockerDelta = require 'docker-delta'
TypedError = require 'typed-error'
_ = require 'lodash'
{ request, resumable } = require './request'
{ envArrayToObject } = require './conversions'
{ checkInt } = require './validation'

applyDelta = (imgSrc, deltaUrl, applyTimeout, opts, onProgress) ->
	new Promise (resolve, reject) ->
		req = resumable(Object.assign({ url: deltaUrl }, opts))
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
				.on('id', (id) -> resolve('sha256:' + id))
				.on('error', req.abort.bind(req))

module.exports = class DockerUtils extends DockerToolbelt
	constructor: (opts) ->
		super(opts)
		@dockerProgress = new DockerProgress(dockerToolbelt: this)
		@supervisorTagPromise = @normaliseImageName(constants.supervisorImage)
		@InvalidNetGatewayError = class InvalidNetGatewayError extends TypedError
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

	# TODO: somehow fix this to work with image names having repo digests instead of tags
	rsyncImageWithProgress: (imgDest, fullDeltaOpts, onProgress) =>
		{
			deltaRequestTimeout, deltaApplyTimeout, deltaRetryCount, deltaRetryInterval,
			uuid, currentApiKey, deltaEndpoint, resinApiEndpoint,
			deltaSource, deltaSourceId, startFromEmpty = false
		} = fullDeltaOpts
		retryCount = checkInt(deltaRetryCount)
		retryInterval = checkInt(deltaRetryInterval)
		requestTimeout = checkInt(deltaRequestTimeout)
		applyTimeout = checkInt(deltaApplyTimeout)
		deltaSource = 'resin/scratch' if startFromEmpty or !deltaSource?
		deltaSourceId ?= deltaSource
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
								deltaSrc = deltaSourceId
							resumeOpts = { timeout: requestTimeout, maxRetries: retryCount, retryInterval }
							resolve(applyDelta(deltaSrc, deltaUrl, applyTimeout, resumeOpts, onProgress))
					.on 'error', reject
		.catch dockerDelta.OutOfSyncError, (err) =>
			console.log('Falling back to regular pull')
			@fetchImageWithProgress(imgDest, fullDeltaOpts, onProgress)

	fetchImageWithProgress: (image, { uuid, currentApiKey }, onProgress) =>
		@getRegistryAndName(image)
		.then ({ registry }) =>
			dockerOptions =
				authconfig:
					username: 'd_' + uuid,
					password: currentApiKey,
					serveraddress: registry
			@dockerProgress.pull(image, onProgress, dockerOptions)
			.then =>
				@getImage(image).inspect().get('Id')

	getImageEnv: (id) ->
		@getImage(id).inspect()
		.get('Config').get('Env')
		.then (env) ->
			envArrayToObject(env)
		.catch (err) ->
			console.log('Error getting env from image', err, err.stack)
			return {}

	getNetworkGateway: (netName) =>
		return Promise.resolve('127.0.0.1') if netName == 'host'
		@getNetwork(netName).inspect()
		.then (netInfo) =>
			conf = netInfo?.IPAM?.Config?[0]
			return conf.Gateway if conf?.Gateway?
			return conf.Subnet.replace('.0/16', '.1') if _.endsWith(conf?.Subnet, '.0/16')
			throw new @InvalidNetGatewayError("Cannot determine network gateway for #{netName}")
