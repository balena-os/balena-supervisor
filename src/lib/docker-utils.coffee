constants = require './constants'
DockerToolbelt = require 'docker-toolbelt'
{ DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
dockerDelta = require 'docker-delta'
_ = require 'lodash'
{ request, resumable } = require './request'
{ envArrayToObject } = require './conversions'
{ DeltaStillProcessingError, InvalidNetGatewayError } = require './errors'
{ checkInt } = require './validation'

applyRsyncDelta = (imgSrc, deltaUrl, applyTimeout, opts, onProgress, log) ->
	log('Applying rsync delta...')
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
				deltaStream = dockerDelta.applyDelta(imgSrc, { log, timeout: applyTimeout })
				res.pipe(deltaStream)
				.on('id', (id) -> resolve('sha256:' + id))
				.on 'error', (err) ->
					log("Delta stream emitted error: #{err}")
					req.abort(err)
					reject(err)

applyBalenaDelta = (docker, deltaImg, token, onProgress, log) ->
	log('Applying balena delta...')
	if token?
		log('Using registry auth token')
		auth = { authconfig: registrytoken: token }
	docker.dockerProgress.pull(deltaImg, onProgress, auth)
	.then ->
		docker.getImage(deltaImg).inspect().get('Id')

module.exports = class DockerUtils extends DockerToolbelt
	constructor: (opts) ->
		super(opts)
		@dockerProgress = new DockerProgress(dockerToolbelt: this)
		@supervisorTagPromise = @normaliseImageName(constants.supervisorImage)

	getRepoAndTag: (image) =>
		@getRegistryAndName(image)
		.then ({ registry, imageName, tagName }) ->
			if registry?
				registry = registry.toString().replace(':443', '')
				repoName = "#{registry}/#{imageName}"
			else
				repoName = imageName
			return { repo: repoName, tag: tagName }

	fetchDeltaWithProgress: (imgDest, fullDeltaOpts, onProgress) =>
		{
			deltaRequestTimeout, deltaApplyTimeout, deltaRetryCount, deltaRetryInterval,
			uuid, currentApiKey, deltaEndpoint, resinApiEndpoint,
			deltaSource, deltaSourceId, deltaVersion, startFromEmpty = false
		} = fullDeltaOpts
		retryCount = checkInt(deltaRetryCount)
		retryInterval = checkInt(deltaRetryInterval)
		requestTimeout = checkInt(deltaRequestTimeout)
		applyTimeout = checkInt(deltaApplyTimeout)
		version = checkInt(deltaVersion)
		deltaSource = 'resin/scratch' if startFromEmpty or !deltaSource?
		deltaSourceId ?= deltaSource

		log = (str) ->
			console.log("delta(#{deltaSource}): #{str}")

		if not (version in [ 2, 3 ])
			log("Unsupported delta version: #{version}. Falling back to regular pull")
			return @fetchImageWithProgress(imgDest, fullDeltaOpts, onProgress)

		docker = this

		log("Starting delta to #{imgDest}")
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
			.then (responseBody) ->
				token = responseBody?.token
				opts =
					followRedirect: false
					timeout: requestTimeout

				if token?
					opts.auth =
						bearer: token
						sendImmediately: true
				request.getAsync("#{deltaEndpoint}/api/v#{version}/delta?src=#{deltaSource}&dest=#{imgDest}", opts)
				.spread (res, data) ->
					if res.statusCode in [ 502, 504 ]
						throw new DeltaStillProcessingError()
					switch version
						when 2
							if not (300 <= res.statusCode < 400 and res.headers['location']?)
								throw new Error("Got #{res.statusCode} when requesting image from delta server.")
							deltaUrl = res.headers['location']
							if deltaSource is 'resin/scratch'
								deltaSrc = null
							else
								deltaSrc = deltaSourceId
							resumeOpts = { timeout: requestTimeout, maxRetries: retryCount, retryInterval }
							applyRsyncDelta(deltaSrc, deltaUrl, applyTimeout, resumeOpts, onProgress, log)
						when 3
							if res.statusCode isnt 200
								throw new Error("Got #{res.statusCode} when requesting image from delta server.")
							name = JSON.parse(data).name
							applyBalenaDelta(docker, name, token, onProgress, log)
						else
							# we guard against arbitrary versions above, so this can't really happen
							throw new Error("Unsupported delta version: #{version}")
		.catch dockerDelta.OutOfSyncError, (err) =>
			log('Falling back to regular pull')
			@fetchImageWithProgress(imgDest, fullDeltaOpts, onProgress)
		.tap ->
			log('Delta applied successfully')
		.tapCatch (err) ->
			log("Delta failed with: #{err}")


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
		.then(envArrayToObject)
		.catch (err) ->
			console.log('Error getting env from image', err, err.stack)
			return {}

	getNetworkGateway: (netName) =>
		return Promise.resolve('127.0.0.1') if netName == 'host'
		@getNetwork(netName).inspect()
		.then (netInfo) ->
			conf = netInfo?.IPAM?.Config?[0]
			return conf.Gateway if conf?.Gateway?
			return conf.Subnet.replace('.0/16', '.1') if _.endsWith(conf?.Subnet, '.0/16')
			throw new InvalidNetGatewayError("Cannot determine network gateway for #{netName}")
