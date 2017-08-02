config = require './config'
process.env.DOCKER_HOST ?= "unix://#{config.dockerSocket}"

Docker = require 'docker-toolbelt'
{ DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
dockerDelta = require 'docker-delta'

_ = require 'lodash'
knex = require './db'
{ request, resumable } = require './request'
Lock = require 'rwlock'
utils = require './utils'
rimraf = Promise.promisify(require('rimraf'))

exports.docker = docker = new Docker()
dockerProgress = new DockerProgress(dockerToolbelt: docker)

# Create an array of (repoTag, image_id, created) tuples like the output of `docker images`
listRepoTags = ->
	docker.listImages()
	.then (images) ->
		images = _.orderBy(images, 'Created', [ false ])
		ret = []
		for image in images
			for repoTag in image.RepoTags
				ret.push [ repoTag, image.Id, image.Created ]
		return ret

# Find either the most recent image of the same app or the image of the supervisor.
# Returns an image Id or Tag (depending on whatever's available)
findSimilarImage = (repoTag) ->
	application = repoTag.split('/')[1]

	listRepoTags()
	.then (repoTags) ->
		# Find the most recent image of the same application
		for repoTag in repoTags
			otherApplication = repoTag[0].split('/')[1]
			if otherApplication is application
				return repoTag[0]

		# Otherwise we start from scratch
		return 'resin/scratch'

getRepoAndTag = (image) ->
	docker.getRegistryAndName(image)
	.then ({ registry, imageName, tagName }) ->
		if registry? and registry != 'docker.io'
			registry = registry.toString().replace(':443', '') + '/'
		else
			registry = ''
		return { repo: "#{registry}#{imageName}", tag: tagName }

applyDelta = (imgSrc, deltaUrl, { requestTimeout, applyTimeout, retryCount, retryInterval }, onProgress) ->
	new Promise (resolve, reject) ->
		resumable(request, { url: deltaUrl, timeout: requestTimeout })
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

do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	_readLock = Promise.promisify(_lock.async.readLock)
	writeLockImages = ->
		_writeLock('images')
		.disposer (release) ->
			release()
	readLockImages = ->
		_readLock('images')
		.disposer (release) ->
			release()

	exports.rsyncImageWithProgress = (imgDest, { requestTimeout, applyTimeout, retryCount, retryInterval, uuid, apiKey, startFromEmpty = false }, onProgress) ->
		Promise.using readLockImages(), ->
			Promise.try ->
				if startFromEmpty
					return 'resin/scratch'
				findSimilarImage(imgDest)
			.then (imgSrc) ->
				Promise.join docker.getRegistryAndName(imgDest), docker.getRegistryAndName(imgSrc), (dstInfo, srcInfo) ->
					tokenEndpoint = "#{config.apiEndpoint}/auth/v1/token"
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
							request.get("#{config.deltaHost}/api/v2/delta?src=#{imgSrc}&dest=#{imgDest}", opts)
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
									deltaOpts = { requestTimeout, applyTimeout, retryCount, retryInterval }
									resolve(applyDelta(deltaSrc, deltaUrl, deltaOpts, onProgress))
							.on 'error', reject
			.then (id) ->
				getRepoAndTag(imgDest)
				.then ({ repo, tag }) ->
					docker.getImage(id).tag({ repo, tag, force: true })
			.catch dockerDelta.OutOfSyncError, (err) ->
				console.log('Falling back to delta-from-empty')
				exports.rsyncImageWithProgress(imgDest, { requestTimeout, totalTimeout, uuid, apiKey, startFromEmpty: true }, onProgress)

	exports.fetchImageWithProgress = (image, onProgress, { uuid, apiKey }) ->
		Promise.using readLockImages(), ->
			docker.getRegistryAndName(image)
			.then ({ registry, imageName, tagName }) ->
				dockerOptions =
					authconfig:
						username: 'd_' + uuid,
						password: apiKey,
						serveraddress: registry
				dockerProgress.pull(image, onProgress, dockerOptions)

	normalizeRepoTag = (image) ->
		getRepoAndTag(image)
		.then ({ repo, tag }) ->
			buildRepoTag(repo, tag)

	supervisorTagPromise = normalizeRepoTag(config.supervisorImage)

	exports.cleanupContainersAndImages = (extraImagesToIgnore = []) ->
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

	containerHasExited = (id) ->
		docker.getContainer(id).inspect()
		.then (data) ->
			return not data.State.Running

	buildRepoTag = (repo, tag, registry) ->
		repoTag = ''
		if registry?
			repoTag += registry + '/'
		repoTag += repo
		if tag?
			repoTag += ':' + tag
		else
			repoTag += ':latest'
		return repoTag

	exports.getImageEnv = (id) ->
		docker.getImage(id).inspect()
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
