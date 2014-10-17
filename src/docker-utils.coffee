Docker = require 'dockerode'
Promise = require 'bluebird'
config = require './config'
JSONStream = require 'JSONStream'
es = require 'event-stream'

docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

exports.docker = docker
exports.fetchImage = (image) ->
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