es = require 'event-stream'
Docker = require 'dockerode'
Promise = require 'bluebird'
JSONStream = require 'JSONStream'
config = require './config'

DOCKER_SOCKET = '/run/docker.sock'

docker = Promise.promisifyAll(new Docker(socketPath: DOCKER_SOCKET))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

localImage = 'resin/rpi-supervisor'
remoteImage = config.REGISTRY_ENDPOINT + '/' + localImage

supervisorUpdating = Promise.resolve()
exports.update = ->
	# Make sure only one attempt to update the full supervisor is running at a time, ignoring any errors from previous update attempts
	supervisorUpdating = supervisorUpdating.catch(->).then -> 
		console.log('Fetching updated supervisor:', remoteImage)
		docker.createImageAsync(fromImage: remoteImage)
	.then (stream) ->
		return new Promise (resolve, reject) ->
			if stream.headers['content-type'] is 'application/json'
				stream.pipe(JSONStream.parse('error'))
				.pipe(es.mapSync(reject))
			else
				stream.pipe(es.wait((error, text) -> reject(text)))

			stream.on('end', resolve)
	.then ->
		console.log('Tagging updated supervisor:', remoteImage)
		docker.getImage(remoteImage).tagAsync(
			repo: localImage
			force: true
		)
	.then ->
		console.log('Creating updated supervisor container:', localImage)
		docker.createContainerAsync(
			Image: localImage
			Cmd: ['/start']
			Volumes:
				'/boot/config.json': '/mnt/mmcblk0p1/config.json'
				'/data': '/var/lib/docker/data'
				'/run/docker.sock': '/var/run/docker.sock'
			Env: [
				'API_ENDPOINT=' + config.API_ENDPOINT
				'REGISTRY_ENDPOINT=' + config.REGISTRY_ENDPOINT
			]
		)
	.then (container) ->
		console.log('Starting updated supervisor container:', localImage)
		container.startAsync(
			Privileged: true
			Binds: [
				'/mnt/mmcblk0p1/config.json:/boot/config.json'
				'/var/run/docker.sock:/run/docker.sock'
				'/var/lib/docker/data:/data'
			]
		)
	.then ->
		# We've started the new container, so we're done here! #pray
		process.exit()
	.catch (err) ->
		console.error('Error updating supervisor:', err)
		throw err
