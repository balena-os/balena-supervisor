_ = require 'lodash'
es = require 'event-stream'
url = require 'url'
knex = require './db'
path = require 'path'
config = require './config'
dockerUtils = require './docker-utils'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'
PlatformAPI = require 'resin-platform-api/request'
utils = require './utils'
tty = require './tty'

{docker} = dockerUtils

PLATFORM_ENDPOINT = url.resolve(config.apiEndpoint, '/ewa/')
resinAPI = new PlatformAPI(PLATFORM_ENDPOINT)

pubnub = PUBNUB.init(config.pubnub)

# Queue up any calls to publish while we wait for the uuid to return from the sqlite db
publish = do ->
	publishQueue = []

	knex('config').select('value').where(key: 'uuid').then ([ uuid ]) ->
		uuid = uuid.value
		channel = "device-#{uuid}-logs"

		# Redefine original function
		publish = (message) ->
			pubnub.publish({ channel, message })

		# Replay queue now that we have initialised the publish function
		publish(args...) for args in publishQueue

	return -> publishQueue.push(arguments)

exports.logSystemEvent = logSystemEvent = (message) ->
	publish("[system] " + message)

exports.kill = kill = (app) ->
	logSystemEvent('Killing application ' + app.imageId)
	utils.mixpanelTrack('Application kill', app)
	updateDeviceInfo(status: 'Stopping')
	container = docker.getContainer(app.containerId)
	console.log('Stopping and deleting container:', container)
	tty.stop()
	.catch (err) ->
		console.error('Error stopping tty', err)
		return # Even if stopping the tty fails we want to finish stopping the container
	.then ->
		container.stopAsync()
	.then ->
		container.removeAsync()
	# Bluebird throws OperationalError for errors resulting in the normal execution of a promisified function.
	.catch Promise.OperationalError, (err) ->
		# Get the statusCode from the original cause and make sure statusCode its definitely a string for comparison
		# reasons.
		statusCode = '' + err.cause.statusCode
		# 304 means the container was already stopped - so we can just remove it
		if statusCode is '304'
			return container.removeAsync()
		# 404 means the container doesn't exist, precisely what we want! :D
		if statusCode is '404'
			return
		throw err
	.tap ->
		utils.mixpanelTrack('Application stop', app.imageId)
		knex('app').where('id', app.id).delete()
	.finally ->
		updateDeviceInfo(status: 'Idle')

isValidPort = (port) ->
	maybePort = parseInt(port, 10)
	return parseFloat(port) is maybePort and maybePort > 0 and maybePort < 65535

exports.start = start = (app) ->
	Promise.try ->
		# Parse the env vars before trying to access them, that's because they have to be stringified for knex..
		JSON.parse(app.env)
	.then (env) ->
		if env.PORT?
			portList = env.PORT
			.split(',')
			.map((port) -> port.trim())
			.filter(isValidPort)

		if app.containerId?
			# If we have a container id then check it exists and if so use it.
			container = docker.getContainer(app.containerId)
			containerPromise = container.inspectAsync().return(container)
		else
			containerPromise = Promise.rejected()

		# If there is no existing container then create one instead.
		containerPromise.catch ->
			docker.getImage(app.imageId).inspectAsync()
			.catch (error) ->
				utils.mixpanelTrack('Application install', app)
				logSystemEvent('Installing application ' + app.imageId)
				updateDeviceInfo(status: 'Downloading')
				dockerUtils.fetchImageWithProgress app.imageId, (progress) ->
					updateDeviceInfo(download_progress: progress.percentage)
			.then ->
				console.log('Creating container:', app.imageId)
				updateDeviceInfo(status: 'Starting')
				ports = {}
				if portList?
					portList.forEach (port) ->
						ports[port + '/tcp'] = {}

				docker.createContainerAsync(
					Image: app.imageId
					Cmd: [ '/bin/bash', '-c', '/start' ]
					Tty: true
					Volumes:
						'/data': {}
						'/lib/modules': {}
					Env: _.map env, (v, k) -> k + '=' + v
					ExposedPorts: ports
				)
		.tap (container) ->
			# Update the app info the moment we create the container, even if then starting the container fails.  This
			# stops issues with constantly creating new containers for an image that fails to start.
			app.containerId = container.id
			if app.id?
				knex('app').update(app).where(id: app.id)
			else
				knex('app').insert(app)
		.tap (container) ->
			console.log('Starting container:', app.imageId)
			ports = {}
			if portList?
				portList.forEach (port) ->
					ports[port + '/tcp'] = [ HostPort: port ]
			container.startAsync(
				Privileged: true
				NetworkMode: "host"
				PortBindings: ports
				Binds: [
					'/resin-data/' + app.appId + ':/data'
					'/lib/modules:/lib/modules'
					'/var/run/docker.sock:/run/docker.sock'
				]
			)
			.then ->
				updateDeviceInfo(commit: app.commit)
				container.attachAsync({ stream: true, stdout: true, stderr: true, tty: true })
			.then (stream) ->
				es.pipeline(
					stream
					es.split()
					es.mapSync(publish)
				)
	.tap ->
		utils.mixpanelTrack('Application start', app.imageId)
		logSystemEvent('Starting application ' + app.imageId)
	.finally ->
		updateDeviceInfo(status: 'Idle', download_progress: null, provisioning_progress: null)

# 0 - Idle
# 1 - Updating
# 2 - Update required
currentlyUpdating = 0
failedUpdates = 0
exports.update = update = ->
	if currentlyUpdating isnt 0
		# Mark an update required after the current.
		currentlyUpdating = 2
		return
	updateDeviceInfo(status: 'Checking Updates')
	currentlyUpdating = 1
	Promise.all([
		knex('config').select('value').where(key: 'apiKey')
		knex('config').select('value').where(key: 'uuid')
		knex('app').select()
	])
	.then ([ [ apiKey ], [ uuid ], apps ]) ->
		apiKey = apiKey.value
		uuid = uuid.value
		resinAPI.get(
			resource: 'application'
			options:
				expand: 'environment_variable'
				filter:
					'device/uuid': uuid
			customOptions:
				apikey: apiKey
		)
		.then (remoteApps) ->
			console.log('Remote apps')
			remoteApps = _.filter(remoteApps, 'commit')
			remoteApps = _.map remoteApps, (app) ->
				env =
					RESIN_DEVICE_UUID: uuid
					RESIN: '1'
					USER: 'root'

				if app.environment_variable?
					for envVar in app.environment_variable
						env[envVar.name] = envVar.value
				return {
					appId: '' + app.id
					commit: app.commit
					imageId: "#{config.registryEndpoint}/#{path.basename(app.git_repository, '.git')}/#{app.commit}"
					env: JSON.stringify(env) # The env has to be stored as a JSON string for knex
				}

			remoteApps = _.indexBy(remoteApps, 'imageId')
			remoteImages = _.keys(remoteApps)
			console.log(remoteImages)

			console.log('Local apps')
			apps = _.indexBy(apps, 'imageId')
			localApps = _.mapValues apps, (app) ->
				_.pick(app, [ 'appId', 'commit', 'imageId', 'env' ])
			localImages = _.keys(localApps)
			console.log(localImages)

			console.log('Apps to be removed')
			toBeRemoved = _.difference(localImages, remoteImages)
			console.log(toBeRemoved)

			console.log('Apps to be installed')
			toBeInstalled = _.difference(remoteImages, localImages)
			console.log(toBeInstalled)

			console.log('Apps to be updated')
			toBeUpdated = _.intersection(remoteImages, localImages)
			toBeUpdated = _.filter toBeUpdated, (imageId) ->
				return !_.isEqual(remoteApps[imageId], localApps[imageId])
			console.log(toBeUpdated)

			# Delete all the ones to remove in one go
			Promise.map toBeRemoved, (imageId) ->
				kill(apps[imageId])
			.then ->
				# Then install the apps and add each to the db as they succeed
				installingPromises = toBeInstalled.map (imageId) ->
					app = remoteApps[imageId]
					start(app)
				# And remove/recreate updated apps and update db as they succeed
				updatingPromises = toBeUpdated.map (imageId) ->
					localApp = apps[imageId]
					app = remoteApps[imageId]
					utils.mixpanelTrack('Application update', app)
					logSystemEvent('Updating application')
					kill(localApp)
					.then ->
						start(app)
				Promise.all(installingPromises.concat(updatingPromises))
	.then ->
		failedUpdates = 0
		updateDeviceInfo(status: 'Cleaning old images')
		# We cleanup here as we want a point when we have a consistent apps/images state, rather than potentially at a
		# point where we might clean up an image we still want.
		dockerUtils.cleanupContainersAndImages()
	.catch (err) ->
		failedUpdates++
		if currentlyUpdating is 2
			console.log('Updating failed, but there is already another update scheduled immediately: ', err)
			return
		delayTime = Math.min(failedUpdates * 500, 30000)
		# If there was an error then schedule another attempt briefly in the future.
		console.log('Scheduling another update attempt due to failure: ', delayTime, err)
		setTimeout(update, delayTime)
	.finally ->
		updateDeviceInfo(status: 'Idle')
		if currentlyUpdating is 2
			# If an update is required then schedule it
			setTimeout(update)
		# Set the updating as finished
		currentlyUpdating = 0

exports.updateDeviceInfo = updateDeviceInfo = (body) ->
	Promise.all([
		knex('config').select('value').where(key: 'apiKey')
		knex('config').select('value').where(key: 'uuid')
	])
	.spread ([{value: apiKey}], [{value: uuid}]) ->
		resinAPI.get(
			resource: 'device'
			options:
				select: 'id'
				filter:
					uuid: uuid
			customOptions:
				apikey: apiKey
		)
		.then (devices) ->
			if devices.length is 0
				throw new Error('Could not find this device?!')
			deviceID = devices[0].id
			resinAPI.patch(
				resource: 'device'
				id: deviceID
				body: body
				customOptions:
					apikey: apiKey
			)
	.catch (error) ->
		utils.mixpanelTrack('Device info update failure', {error, body})

