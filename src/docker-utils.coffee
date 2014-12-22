Docker = require 'dockerode'
Promise = require 'bluebird'
config = require './config'
JSONStream = require 'JSONStream'
es = require 'event-stream'
_ = require 'lodash'
knex = require './db'

request = require './request'

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

	supervisorImages = [ "#{config.localImage}:latest", "#{config.remoteImage}:latest" ]
	exports.cleanupContainersAndImages = ->
		knex('app').select()
		.map (app) ->
			app.imageId + ':latest'
		.then (apps) ->
			# Cleanup containers first, so that they don't block image removal.
			docker.listContainersAsync(all: true)
			.filter (containerInfo) ->
				# Do not remove user apps.
				if _.contains(apps, containerInfo.Image)
					return false
				if !_.contains(supervisorImages, containerInfo.Image)
					return true
				return containerHasExited(containerInfo.Id)
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
						_.contains(apps, imageId) or _.contains(supervisorImages, imageId)
				.map (image) ->
					docker.getImage(image.Id).removeAsync()
					.then ->
						console.log('Deleted image:', image.Id, image.RepoTags)
					.catch (err) ->
						console.log('Error deleting image:', image.Id, image.RepoTags, err)

	exports.containerHasExited = (id) ->
		docker.getContainer(id).inspectAsync()
		.then (data) ->
			return not data.Status.Running

	# Return true if an image exists in the local docker repository, false otherwise.
	exports.imageExists = imageExists = (imageId) ->
		image = docker.getImage(imageId)
		image.inspectAsync().then ->
			return true
		.catch (e) ->
			return false

	# Get the id of an image on a given registry and tag.
	exports.getImageId = getImageId = (registry, imageName, tag='latest') ->
		request.getAsync("http://#{registry}/v1/repositories/#{imageName}/tags")
		.spread (res, data) ->
			if res.statusCode == 404
				throw new Error("No such image #{imageName} on registry #{registry}")
			if res.statusCode >= 400
				throw new Error("Failed to get image tags of #{imageName} from #{registry}. Status code: #{res.statusCode}")
			tags = JSON.parse(data)
			return tags[tag]

	# Return the ids of the layers of an image.
	exports.getImageHistory = getImageHistory = (registry, imageId) ->
		request.getAsync("http://#{registry}/v1/images/#{imageId}/ancestry")
		.spread (res, data) ->
			if res.statusCode >= 400
				throw new Error("Failed to get image ancestry of #{imageId} from #{registry}. Status code: #{res.statusCode}")
			history = JSON.parse(data)
			return history

	# Return the number of bytes docker has to download to pull this image (or layer).
	# If the image is already downloaded, then 0 is returned.
	exports.getImageDownloadSize = getImageDownloadSize = (registry, imageId) ->
		imageExists(imageId)
		.then (exists) ->
			if exists
				return 0
			request.getAsync("http://#{registry}/v1/images/#{imageId}/json")
			.spread (res, data) ->
				if res.statusCode >= 400
					throw new Error("Failed to get image download size of #{imageId} from #{registry}. Status code: #{res.statusCode}")
				return parseInt(res.headers['x-docker-size'])

	# Get download size of the layers of an image.
	# The object returned has layer ids as keys and their download size as values.
	# Download size is the size that docker will download if the image will be pulled now.
	# If some layer is already downloaded, it will return 0 size for that layer.
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

	# Return percentage from current completed/total, handling edge cases.
	# Null total is considered an unknown total and 0 percentage is returned.
	calculatePercentage = (completed, total) ->
		if not total?
			percentage = 0 # report 0% if unknown total size
		else if total is 0
			percentage = 100 # report 100% if 0 total size
		else
			percentage = (100 * completed) // total
		return percentage

	# Separate string containing registry and image name into its parts.
	# Example: registry.staging.resin.io/resin/rpi
	#          { registry: "registry.staging.resin.io", imageName: "resin/rpi" }
	getRegistryAndName = (image) ->
		[ m, registry, imageName ] = image.match(/(.+[:.].+)\/(.+\/.+)/)
		if not registry
			throw new Error("Expected image name to include registry domain name")
		if not imageName
			throw new Error("Invalid image name, expected domain.tld/repo/image format.")
		return {registry, imageName}
	
	# Create a stream that transforms docker pull output 
	# to include total progress metrics.
	# 
	# The docker pull output should be piped to this stream as separate javascript objects.
	#
	# Stream:
	# { status: "status", progressDetail: { current } }
	#                     =>
	# { status: "status", progressDetail: { current }, totalProgress: { downloadedSize, totalSize, percentage } }
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
			.catch (e) ->
				callback(null, { error: e.message })
