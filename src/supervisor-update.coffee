config = require './config'
Docker = require 'dockerode'
Promise = require 'bluebird'
_ = require 'lodash'

docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

localImage = 'resin/rpi-supervisor'
remoteImage = config.registryEndpoint + '/' + localImage

startNewSupervisor = (currentSupervisor) ->
	console.log('Creating supervisor container:', localImage)
	docker.createContainerAsync(
		Image: localImage
		Cmd: ['/start']
		Volumes: config.supervisorContainer.Volumes
		Env: currentSupervisor.Config.Env
	)
	.then (container) ->
		console.log('Starting supervisor container:', localImage)
		container.startAsync(
			Privileged: true
			Binds: config.supervisorContainer.Binds
		)
	.then ->
		# We've started the new container, so we're done here! #pray
		console.log('Exiting to let the new supervisor take over')
		process.exit()

# Docker sets the HOSTNAME as the container's short id.
currentSupervisor = docker.getContainer(process.env.HOSTNAME).inspectAsync().tap (currentSupervisor) ->
	# The volume keys are the important bit.
	expectedVolumes = _.sortBy(_.keys(config.supervisorContainer.Volumes))
	actualVolumes = _.sortBy(_.keys(currentSupervisor.Volumes))

	expectedBinds = _.sortBy(config.supervisorContainer.Binds)
	actualBinds = _.sortBy(currentSupervisor.HostConfig.Binds)

	# Check all the expected binds and volumes exist, if not then start a new supervisor (which will add them correctly)
	if !_.isEqual(expectedVolumes, actualVolumes) or !_.isEqual(expectedBinds, actualBinds)
		console.log('Supervisor restart (for binds/mounts)')
		startNewSupervisor(currentSupervisor)

# This is a promise that resolves when we have fully initialised.
exports.initialised = currentSupervisor.then (currentSupervisor) ->
	es = require 'event-stream'
	utils = require './utils'
	JSONStream = require 'JSONStream'

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
					stream.pipe es.wait (error, text) ->
						if error
							reject(text)

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
				currentSupervisor
			])
		.spread (localImageInfo, currentSupervisor) ->
			localImageId = localImageInfo.Id or localImageInfo.id
			if localImageId is currentSupervisor.Image
				utils.mixpanelTrack('Supervisor up to date')
				return
			utils.mixpanelTrack('Supervisor update start', image: localImageId)
			startNewSupervisor(currentSupervisor)
		.catch (err) ->
			utils.mixpanelTrack('Supervisor update failed', error: err)
			throw err
