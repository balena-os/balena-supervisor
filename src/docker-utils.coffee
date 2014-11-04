Docker = require 'dockerode'
Promise = require 'bluebird'
config = require './config'
JSONStream = require 'JSONStream'
es = require 'event-stream'
_ = require 'lodash'
knex = require './db'

request = Promise.promisify(require 'request')

docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().constructor.prototype)
Promise.promisifyAll(docker.getContainer().constructor.prototype)

exports.docker = docker

do ->
	# Keep track of the images being fetched, so we don't clean them up whilst fetching.
	imagesBeingFetched = 0
	exports.fetchImage = (image) ->
		imagesBeingFetched++
		docker.createImageAsync(fromImage: image)
		.then (stream) ->
			return new Promise (resolve, reject) ->
				if stream.headers['content-type'] is 'application/json'
					stream.pipe(JSONStream.parse('error'))
					.pipe(es.mapSync(reject))
				else
					stream.pipe es.wait (error, text) ->
						if error
							reject(text)

				stream.on('end', resolve)
		.finally ->
			imagesBeingFetched--

	# Pull docker image returning a stream that reports progress
	# This is less safe than fetchImage and shouldnt be used for supervisor updates
	exports.fetchImageWithProgress = (image, progressUpdates) ->
		imagesBeingFetched++
		docker.createImageAsync(fromImage: image)
		.then (stream) ->
			return new Promise (resolve, reject) ->
				stream.on('error', reject)
				.pipe(JSONStream.parse())
				.on('error', reject)
				.pipe(pullProgressStream(image))
				.pipe es.mapSync (data) ->
					if data.error?
						reject(data.error)
					else if data.totalProgress?
						progressUpdates?(data.totalProgress)
				.on('end', resolve)
		.finally ->
			imagesBeingFetched--

	exports.cleanupContainersAndImages = ->
		knex('app').select()
		.map (app) ->
			app.imageId + ':latest'
		.then (apps) ->
			# Make sure not to delete the supervisor image!
			apps.push(config.localImage + ':latest')
			apps.push(config.remoteImage + ':latest')

			# Cleanup containers first, so that they don't block image removal.
			docker.listContainersAsync(all: true)
			.filter (containerInfo) ->
				!_.contains(apps, containerInfo.Image)
			.map (containerInfo) ->
				docker.getContainer(containerInfo.Id).removeAsync()
				.then ->
					console.log('Deleted container:', containerInfo.Id, containerInfo.Image)
				.catch (err) ->
					console.log('Error deleting container:', containerInfo.Id, containerInfo.Image, err)
			.then ->
				# And then clean up the images, as long as we aren't currently trying to fetch any.
				return if imagesBeingFetched > 0
				docker.listImagesAsync()
				.filter (image) ->
					!_.any image.RepoTags, (imageId) ->
						_.contains(apps, imageId)
				.map (image) ->
					docker.getImage(image.Id).removeAsync()
					.then ->
						console.log('Deleted image:', image.Id, image.RepoTags)
					.catch (err) ->
						console.log('Error deleting image:', image.Id, image.RepoTags, err)

	exports.imageExists = imageExists = (imageId) ->
		image = docker.getImage(imageId)
		image.inspectAsync().then ->
			return true
		.catch (e) ->
			return false

	exports.getImageId = getImageId = (registry, imageName, tag='latest') ->
		request("http://#{registry}/v1/repositories/#{imageName}/tags")
		.spread (res, data) ->
			if res.statusCode == 404
				throw new Error("No such image #{imageName} on registry #{registry}")
			if res.statusCode >= 400
				throw new Error("Failed to get image tags of #{imageName} from #{registry}. Status code: #{res.statusCode}")
			tags = JSON.parse(data)
			return tags[tag]

	exports.getImageHistory = getImageHistory = (registry, imageId) ->
		request("http://#{registry}/v1/images/#{imageId}/ancestry")
		.spread (res, data) ->
			if res.statusCode >= 400
				throw new Error("Failed to get image ancestry of #{imageId} from #{registry}. Status code: #{res.statusCode}")
			history = JSON.parse(data)
			return history

	exports.getImageDownloadSize = getImageDownloadSize = (registry, imageId) ->
		imageExists(imageId)
		.then (exists) ->
			if exists
				return 0
			request("http://#{registry}/v1/images/#{imageId}/json")
			.spread (res, data) ->
				if res.statusCode >= 400
					throw new Error("Failed to get image download size of #{imageId} from #{registry}. Status code: #{res.statusCode}")
				return parseInt(res.headers['x-docker-size'])

	exports.getLayerDownloadSizes = getLayerDownloadSizes = (image, tag='latest') ->
		{registry, imageName} = getRegistryAndName(image)
		imageSizes = {}
		getImageId(registry, imageName, tag)
		.then (imageId) ->
			getImageHistory(registry, imageId)
		.map (layerId) ->
			getImageDownloadSize(registry, layerId).then (size) ->
				imageSizes[layerId] = size
		.return(imageSizes)

	calculatePercentage = (completed, total) ->
		if not total?
			percentage = 0 # report 0% if unknown total size
		else if total is 0
			percentage = 100 # report 100% if 0 total size
		else
			percentage = (100 * completed) // total
		return percentage

	getRegistryAndName = (image) ->
		slashPos = image.indexOf('/')
		if slashPos < 0
			throw new Error("Expected image name including registry domain name")
		registry = image.substr(0,slashPos)
		imageName = image.substr(slashPos+1)
		return {registry, imageName}
	
	# Create a stream that transforms docker pull output 
	# to include total progress metrics.
	# 
	# The docker pull output should be piped to this stream as separate javascript objects.
	pullProgressStream = (image) ->
		totalSize = 0
		completedSize = 0
		currentSize = 0
		sizePromise = getLayerDownloadSizes(image).tap (layerSizes) ->
			totalSize = _.reduce(layerSizes, ((t,x) -> t+x), 0)
		es.map (pull, callback) ->
			sizePromise.then (layerSizes) ->
				if pull.status == 'Downloading'
					currentSize = pull.progressDetail.current
				else if pull.status == 'Download complete'
					shortId = pull.id
					longId = _.find(_.keys(layerSizes), (id) -> id.indexOf(shortId) is 0)
					if longId?
						completedSize += layerSizes[longId]
						currentSize = 0
						layerSizes[longId] = 0 # make sure we don't count this layer again
					else
						console.log 'Progress error: Unknown layer ' + id + ' downloaded by docker. Progress not correct.'
						totalSize = null
				downloadedSize = completedSize + currentSize
				percentage = calculatePercentage(downloadedSize, totalSize)
				pull.totalProgress = { downloadedSize, totalSize, percentage }
				callback(null, pull)
			.catch (error) =>
				callback(null, { error })
