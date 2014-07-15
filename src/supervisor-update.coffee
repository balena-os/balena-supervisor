es = require 'event-stream'
utils = require './utils'
config = require './config'
Docker = require 'dockerode'
Promise = require 'bluebird'
JSONStream = require 'JSONStream'


docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

localImage = 'resin/rpi-supervisor'
remoteImage = config.registryEndpoint + '/' + localImage

# Docker sets the HOSTNAME as the container's short id.
currentSupervisorImage = docker.getContainer(process.env.HOSTNAME).inspectAsync().then (info) ->
	return info.Image

supervisorUpdating = Promise.resolve()
exports.update = ->
	# Make sure only one attempt to update the full supervisor is running at a time, ignoring any errors from previous update attempts
	supervisorUpdating = supervisorUpdating.catch(->).then ->
		utils.mixpanelTrack('Supervisor update check')
		console.log('Fetching supervisor:', remoteImage)
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
		console.log('Tagging supervisor:', remoteImage)
		docker.getImage(remoteImage).tagAsync(
			repo: localImage
			force: true
		)
	.then ->
		console.log('Inspecting newly tagged supervisor:', localImage)
		Promise.all([
			docker.getImage(localImage).inspectAsync()
			currentSupervisorImage
		])
	.spread (localImageInfo, currentSupervisorImage) ->
		localImageId = localImageInfo.Id or localImageInfo.id
		if localImageId is currentSupervisorImage
			utils.mixpanelTrack('Supervisor up to date')
			return
		utils.mixpanelTrack('Supervisor update start', image: localImageId)
		docker.createContainerAsync(
			Image: localImage
			Cmd: ['/start']
			Volumes:
				'/boot/config.json': '/mnt/mmcblk0p1/config.json'
				'/data': '/var/lib/docker/data'
				'/run/docker.sock': '/var/run/docker.sock'
				'/mnt/fib_trie': '/proc/net/fib_trie'
			# Copy the env vars directly from the current container - using both upper/lower case to account for different docker versions.
			Env: localImageInfo.Env ? localImageInfo.env
		)
		.then (container) ->
			console.log('Starting updated supervisor container:', localImage)
			container.startAsync(
				Privileged: true
				Binds: [
					'/mnt/mmcblk0p1/config.json:/boot/config.json'
					'/var/run/docker.sock:/run/docker.sock'
					'/var/lib/docker/data:/data'
					'/proc/net/fib_trie:/mnt/fib_trie'
				]
			)
		.then ->
			# We've started the new container, so we're done here! #pray
			console.log('Exiting to let the new supervisor take over')
			process.exit()
	.catch (err) ->
		utils.mixpanelTrack('Supervisor update failed', error: err)
		throw err
