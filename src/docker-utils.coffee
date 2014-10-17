Docker = require 'dockerode'
Promise = require 'bluebird'
config = require './config'
JSONStream = require 'JSONStream'
es = require 'event-stream'
_ = require 'lodash'
knex = require './db'

docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

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
