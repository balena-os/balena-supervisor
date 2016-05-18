Docker = require 'dockerode'
{ getRegistryAndName, DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
{ spawn, execAsync } = Promise.promisifyAll require 'child_process'
progress = require 'request-progress'
config = require './config'
_ = require 'lodash'
knex = require './db'
TypedError = require 'typed-error'
{ request } = require './request'
fs = Promise.promisifyAll require 'fs'
Lock = require 'rwlock'
class OutOfSyncError extends TypedError

docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().constructor.prototype)
Promise.promisifyAll(docker.getContainer().constructor.prototype)

exports.docker = docker
dockerProgress = new DockerProgress(socketPath: config.dockerSocket)

# Create an array of (repoTag, image_id, created) tuples like the output of `docker images`
listRepoTagsAsync = ->
	docker.listImagesAsync()
	.then (images) ->
		images = _.sortByOrder(images, 'Created', [ false ])
		ret = []
		for image in images
			for repoTag in image.RepoTags
				ret.push [ repoTag, image.Id, image.Created ]
		return ret

# Find either the most recent image of the same app or the image of the supervisor.
# Returns an image Id or Tag (depending on whatever's available)
findSimilarImage = (repoTag) ->
	application = repoTag.split('/')[1]

	listRepoTagsAsync()
	.then (repoTags) ->
		# Find the most recent image of the same application
		for repoTag in repoTags
			otherApplication = repoTag[0].split('/')[1]
			if otherApplication is application
				return repoTag[0]

		# Otherwise return the image for the most specific supervisor tag (commit hash)
		for repoTag in repoTags when /resin\/.*-supervisor.*:[0-9a-f]{6}/.test(repoTag[0])
			return repoTag[0]

		# Or return *any* supervisor image available (except latest which is usually a phony tag)
		for repoTag in repoTags when /resin\/.*-supervisor.*:(?!latest)/.test(repoTag[0])
			return repoTag[0]

		# If all else fails, return the newest image available
		for repoTag in repoTags when repoTag[0] isnt '<none>:<none>'
			return repoTag[0]

		return 'resin/scratch'

DELTA_OUT_OF_SYNC_CODES = [23, 24]
DELTA_REQUEST_TIMEOUT = 15 * 60 * 1000

getRepoAndTag = (image) ->
	getRegistryAndName(image)
	.then ({ registry, imageName, tagName }) ->
		registry = registry.toString().replace(':443','')
		return { repo: "#{registry}/#{imageName}", tag: tagName }

dockerSync = (imgSrc, imgDest, rsyncDiff, conf) ->
	docker.importImageAsync('/app/empty.tar')
	.then (stream) ->
		new Promise (resolve, reject) ->
			streamOutput = ''
			stream.on 'data', (data) ->
				streamOutput += data
			stream.on 'error', reject
			stream.on 'end', ->
				resolve(JSON.parse(streamOutput).status)
	.then (destId) ->
		jsonPath = "#{config.dockerRoot}/graph/#{destId}/json"
		fs.readFileAsync(jsonPath)
		.then(JSON.parse)
		.then (destJson) ->
			destJson.config = conf
			fs.writeFileAsync(jsonPath + '.tmp', JSON.stringify(destJson))
		.then ->
			fs.renameAsync(jsonPath + '.tmp', jsonPath)
		.then ->
			if imgSrc isnt 'resin/scratch'
				execAsync("btrfs subvolume delete \"#{config.btrfsRoot}/#{destId}\"")
				.then ->
					docker.getImage(imgSrc).inspectAsync().get('Id')
				.then (srcId) ->
					execAsync("btrfs subvolume snapshot \"#{config.btrfsRoot}/#{srcId}\" \"#{config.btrfsRoot}/#{destId}\"")
		.then ->
			new Promise (resolve, reject) ->
				rsync = spawn('rsync', ['--timeout=300', '--archive', '--delete' , '--read-batch=-', "#{config.btrfsRoot}/#{destId}"], stdio: 'pipe')
				.on 'error', reject
				.on 'exit', (code, signal) ->
					if code in DELTA_OUT_OF_SYNC_CODES
						reject(new OutOfSyncError('Incompatible image'))
					else if code isnt 0
						reject(new Error("rsync exited. code: #{code} signal: #{signal}"))
					else
						resolve()
				rsyncDiff.pipe(rsync.stdin)
				rsync.stdout.pipe(process.stdout)
				rsync.stderr.pipe(process.stdout)
				rsyncDiff.resume()
		.then ->
			execAsync('sync')
		.then ->
			getRepoAndTag(imgDest)
		.then ({ repo, tag }) ->
			docker.getImage(destId).tagAsync({ repo, tag, force: true })

do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	lockImages = ->
		_writeLock('images')
		.disposer (release) ->
			release()

	exports.rsyncImageWithProgress = (imgDest, onProgress, startFromEmpty = false) ->
		imagesBeingFetched++
		Promise.try ->
			if startFromEmpty
				return 'resin/scratch'
			findSimilarImage(imgDest)
		.then (imgSrc) ->
			rsyncDiff = new Promise (resolve, reject) ->
				progress request.get("#{config.deltaHost}/api/v1/delta?src=#{imgSrc}&dest=#{imgDest}", timeout: DELTA_REQUEST_TIMEOUT)
				.on 'progress', (progress) ->
					onProgress(percentage: progress.percent)
				.on 'end', ->
					onProgress(percentage: 100)
				.on 'response', (res) ->
					if res.statusCode isnt 200
						reject(new Error("Got #{res.statusCode} when requesting image from delta server."))
					else
						resolve(res)
				.on 'error', reject
				.pause()

			imageConfig = request.getAsync("#{config.deltaHost}/api/v1/config?image=#{imgDest}", {json: true, timeout: 0})
			.spread ({statusCode}, imageConfig) ->
				if statusCode isnt 200
					throw new Error("Invalid configuration: #{imageConfig}")
				return imageConfig

			return [ rsyncDiff, imageConfig, imgSrc ]
		.spread (rsyncDiff, imageConfig, imgSrc) ->
			dockerSync(imgSrc, imgDest, rsyncDiff, imageConfig)
		.catch OutOfSyncError, (err) ->
			console.log('Falling back to delta-from-empty')
			exports.rsyncImageWithProgress(imgDest, onProgress, true)
		.finally ->
			imagesBeingFetched--

	# Keep track of the images being fetched, so we don't clean them up whilst fetching.
	imagesBeingFetched = 0
	exports.fetchImageWithProgress = (image, onProgress) ->
		imagesBeingFetched++
		dockerProgress.pull(image, onProgress)
		.finally ->
			imagesBeingFetched--

	supervisorTag = config.supervisorImage
	if !/:/g.test(supervisorTag)
		# If there is no tag then mark it as latest
		supervisorTag += ':latest'
	exports.cleanupContainersAndImages = ->
		Promise.using lockImages(), ->
			Promise.join(
				knex('image').select('repoTag')
				.map (image) ->
					image.repoTag
				knex('app').select()
				.map (app) ->
					app.imageId + ':latest'
				docker.listImagesAsync()
				(localTags, apps, images) ->
					imageTags = _.map(images, 'RepoTags')
					supervisorTags = _.filter imageTags, (tags) ->
						_.contains(tags, supervisorTag)
					appTags = _.filter imageTags, (tags) ->
						_.any tags, (tag) ->
							_.contains(apps, tag)
					locallyCreatedTags = _.filter imageTags, (tags) ->
						_.any tags, (tag) ->
							_.contains(localTags, tag)
					supervisorTags = _.flatten(supervisorTags)
					appTags = _.flatten(appTags)
					locallyCreatedTags = _.flatten(locallyCreatedTags)
					return { images, supervisorTags, appTags, locallyCreatedTags }
			)
			.then ({ images, supervisorTags, appTags, locallyCreatedTags }) ->
				# Cleanup containers first, so that they don't block image removal.
				docker.listContainersAsync(all: true)
				.filter (containerInfo) ->
					# Do not remove user apps.
					if _.contains(appTags, containerInfo.Image)
						return false
					if _.contains(locallyCreatedTags, containerInfo.Image)
						return false
					if !_.contains(supervisorTags, containerInfo.Image)
						return true
					return containerHasExited(containerInfo.Id)
				.map (containerInfo) ->
					docker.getContainer(containerInfo.Id).removeAsync()
					.then ->
						console.log('Deleted container:', containerInfo.Id, containerInfo.Image)
					.catch(_.noop)
				.then ->
					# And then clean up the images, as long as we aren't currently trying to fetch any.
					return if imagesBeingFetched > 0
					imagesToClean = _.reject images, (image) ->
						_.any image.RepoTags, (tag) ->
							return _.contains(appTags, tag) or _.contains(supervisorTags, tag) or _.contains(locallyCreatedTags, tag)
					Promise.map imagesToClean, (image) ->
						Promise.map image.RepoTags.concat(image.Id), (tag) ->
							docker.getImage(tag).removeAsync()
							.then ->
								console.log('Deleted image:', tag, image.Id, image.RepoTags)
							.catch(_.noop)

	containerHasExited = (id) ->
		docker.getContainer(id).inspectAsync()
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

	sanitizeQuery = (query) ->
		_.omit(query, 'apikey')

	exports.createImage = (req, res) ->
		{ registry, repo, tag, fromImage, fromSrc } = req.query
		if fromImage?
			repoTag = fromImage
			repoTag += ':' + tag if tag?
		else
			repoTag = buildRepoTag(repo, tag, registry)
		Promise.using lockImages(), ->
			knex('image').insert({ repoTag })
			.then ->
				if fromImage?
					docker.createImageAsync({ fromImage, tag })
				else
					docker.importImageAsync(req, { repo, tag, registry })
			.then (stream) ->
				stream.pipe(res)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	exports.loadImage = (req, res) ->
		if imagesBeingFetched > 0
			res.status(500).send('Cannot load an image while the supervisor is pulling an update')
			return
		Promise.using lockImages(), ->
			docker.listImagesAsync()
			.then (oldImages) ->
				docker.loadImageAsync(req)
				.then ->
					docker.listImagesAsync()
				.then (newImages) ->
					oldTags = _.flatten(_.map(oldImages, 'RepoTags'))
					newTags = _.flatten(_.map(newImages, 'RepoTags'))
					createdTags = _.difference(newTags, oldTags)
					Promise.map createdTags, (repoTag) ->
						knex('image').insert({ repoTag })
			.then ->
				res.sendStatus(200)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	exports.deleteImage = (req, res) ->
		imageName = req.params[0]
		Promise.using lockImages(), ->
			knex('image').select().where('repoTag', imageName)
			.then (images) ->
				throw new Error('Only images created via the Supervisor can be deleted.') if images.length == 0
				knex('image').where('repoTag', imageName).delete()
			.then ->
				docker.getImage(imageName).removeAsync(sanitizeQuery(req.query))
				.then (data) ->
					res.json(data)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	exports.listImages = (req, res) ->
		docker.listImagesAsync(sanitizeQuery(req.query))
		.then (images) ->
			res.json(images)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	docker.modem.dialAsync = Promise.promisify(docker.modem.dial)
	exports.createContainer = (req, res) ->
		Promise.using lockImages(), ->
			knex('image').select().where('repoTag', req.body.Image)
			.then (images) ->
				throw new Error('Only images created via the Supervisor can be used for creating containers.') if images.length == 0
				optsf =
					path: '/containers/create?'
					method: 'POST'
					options: req.body
					statusCodes:
						200: true
						201: true
						404: 'no such container'
						406: 'impossible to attach'
						500: 'server error'
				docker.modem.dialAsync(optsf)
				.then (data) ->
					res.json(data)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	exports.startContainer = (req, res) ->
		docker.getContainer(req.params.id).startAsync(req.body)
		.then (data) ->
			res.json(data)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	exports.stopContainer = (req, res) ->
		container = docker.getContainer(req.params.id)
		knex('app').select()
		.then (apps) ->
			throw new Error('Cannot stop an app container') if _.any(apps, containerId: req.params.id)
			container.inspectAsync()
		.then (cont) ->
			throw new Error('Cannot stop supervisor container') if cont.Name == '/resin_supervisor' or _.any(cont.Names, (n) -> n == '/resin_supervisor')
			container.stopAsync(sanitizeQuery(req.query))
		.then (data) ->
			res.json(data)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	exports.deleteContainer = (req, res) ->
		container = docker.getContainer(req.params.id)
		knex('app').select()
		.then (apps) ->
			throw new Error('Cannot remove an app container') if _.any(apps, containerId: req.params.id)
			container.inspectAsync()
		.then (cont) ->
			throw new Error('Cannot remove supervisor container') if cont.Name == '/resin_supervisor' or _.any(cont.Names, (n) -> n == '/resin_supervisor')
			container.removeAsync(sanitizeQuery(req.query))
		.then (data) ->
			res.json(data)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')

	exports.listContainers = (req, res) ->
		docker.listContainersAsync(sanitizeQuery(req.query))
		.then (containers) ->
			res.json(containers)
		.catch (err) ->
			res.status(500).send(err?.message or err or 'Unknown error')
