_ = require 'lodash'
url = require 'url'
knex = require './db'
path = require 'path'
config = require './config'
dockerUtils = require './docker-utils'
Promise = require 'bluebird'
utils = require './utils'
tty = require './lib/tty'
logger = require './lib/logger'
{ resinApi, cachedResinApi } = require './request'

{docker} = dockerUtils


knex('config').select('value').where(key: 'uuid').then ([ uuid ]) ->
	logger.init(
		dockerSocket: config.dockerSocket
		pubnub: config.pubnub
		channel: "device-#{uuid.value}-logs"
	)

logTypes =
	stopApp:
		eventName: 'Application kill'
		humanName: 'Killing application'
	stopAppSuccess:
		eventName: 'Application stop'
		humanName: 'Killed application'

	downloadApp:
		eventName: 'Application download'
		humanName: 'Downloading application'
	downloadAppSuccess:
		eventName: 'Application downloaded'
		humanName: 'Downloaded application'

	installApp:
		eventName: 'Application install'
		humanName: 'Installing application'

	startApp:
		eventName: 'Application start'
		humanName: 'Starting application'
	startAppSuccess:
		eventName: 'Application started'
		humanName: 'Started application'
	startAppError:
		eventName: 'Application started'
		humanName: 'Failed to start application'

	updateApp:
		eventName: 'Application update'
		humanName: 'Updating application'

logSystemEvent = (logType, app, err) ->
	message = "#{logType.humanName} '#{app.imageId}'"
	if err?
		# Report the message from the original cause to the user.
		errMessage = err.cause.json ? err.cause.message ? err.message
		message += " due to '#{errMessage}'"
	logger.log({ message, isSystem: true })
	utils.mixpanelTrack(logType.eventName, {app, err})
	return

kill = (app) ->
	logSystemEvent(logTypes.stopApp, app)
	updateDeviceState(status: 'Stopping')
	container = docker.getContainer(app.containerId)
	console.log('Stopping and deleting container:', container)
	tty.stop(app)
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
		logSystemEvent(logTypes.stopAppSuccess, app)
		knex('app').where('id', app.id).delete()

isValidPort = (port) ->
	maybePort = parseInt(port, 10)
	return parseFloat(port) is maybePort and maybePort > 0 and maybePort < 65535

fetch = (app) ->
	docker.getImage(app.imageId).inspectAsync()
	.catch (error) ->
		logSystemEvent(logTypes.downloadApp, app)
		updateDeviceState(status: 'Downloading')
		dockerUtils.fetchImageWithProgress app.imageId, (progress) ->
			updateDeviceState(download_progress: progress.percentage)
		.then ->
			logSystemEvent(logTypes.downloadAppSuccess, app)
			updateDeviceState(download_progress: null)
			docker.getImage(app.imageId).inspectAsync()

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
			fetch(app)
			.then (imageInfo) ->
				logSystemEvent(logTypes.installApp, app)
				updateDeviceState(status: 'Installing')

				ports = {}
				if portList?
					portList.forEach (port) ->
						ports[port + '/tcp'] = {}

				if imageInfo?.Config?.Cmd
					cmd = imageInfo.Config.Cmd
				else
					cmd = [ '/bin/bash', '-c', '/start' ]

				docker.createContainerAsync(
					Image: app.imageId
					Cmd: cmd
					Tty: true
					Volumes:
						'/data': {}
						'/lib/modules': {}
						'/run/dbus': {}
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
			logSystemEvent(logTypes.startApp, app)
			updateDeviceState(status: 'Starting')
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
					'/run/dbus:/run/dbus'
					'/var/run/docker.sock:/run/docker.sock'
				]
			)
			.catch (err) ->
				logSystemEvent(logTypes.startAppError, app, err)
				throw err
			.then ->
				updateDeviceState(commit: app.commit)
				logger.attach(app)
	.tap ->
		logSystemEvent(logTypes.startAppSuccess, app)
	.finally ->
		updateDeviceState(status: 'Idle')

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
	currentlyUpdating = 1
	Promise.all([
		knex('config').select('value').where(key: 'apiKey')
		knex('config').select('value').where(key: 'uuid')
		knex('app').select()
	])
	.then ([ [ apiKey ], [ uuid ], apps ]) ->
		apiKey = apiKey.value
		uuid = uuid.value
		cachedResinApi.get(
			resource: 'application'
			options:
				expand: 'environment_variable'
				select: [
					'id'
					'git_repository'
					'commit'
				]
				filter:
					commit: $ne: null
					device:
						uuid: uuid
			customOptions:
				apikey: apiKey
		)
		.then (remoteApps) ->
			console.log('Remote apps')
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

			# Fetch any updated images first
			Promise.map toBeInstalled, (imageId) ->
				app = remoteApps[imageId]
				fetch(app)
			.then ->
				# Then delete all the ones to remove in one go
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
					logSystemEvent(logTypes.updateApp, app)
					kill(localApp)
					.then ->
						start(app)
				Promise.all(installingPromises.concat(updatingPromises))
	.then ->
		failedUpdates = 0
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
		updateDeviceState(status: 'Idle')
		if currentlyUpdating is 2
			# If an update is required then schedule it
			setTimeout(update)
	.finally ->
		# Set the updating as finished in its own block, so it never has to worry about other code stopping this.
		currentlyUpdating = 0

getDeviceID = do ->
	deviceIdPromise = null
	return ->
		# We initialise the rejected promise just before we catch in order to avoid a useless first unhandled error warning.
		deviceIdPromise ?= Promise.rejected()
		# Only fetch the device id once (when successful, otherwise retry for each request)
		deviceIdPromise = deviceIdPromise.catch ->
			Promise.all([
				knex('config').select('value').where(key: 'apiKey')
				knex('config').select('value').where(key: 'uuid')
			])
			.spread ([{value: apiKey}], [{value: uuid}]) ->
				resinApi.get(
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
				return devices[0].id

# Calling this function updates the local device state, which is then used to synchronise
# the remote device state, repeating any failed updates until successfully synchronised.
# This function will also optimise updates by merging multiple updates and only sending the latest state.
exports.updateDeviceState = updateDeviceState = do ->
	applyPromise = Promise.resolve()
	targetState = {}
	actualState = {}

	getStateDiff = ->
		_.omit targetState, (value, key) ->
			actualState[key] is value

	applyState = ->
		if _.size(getStateDiff()) is 0
			return

		applyPromise = Promise.join(
			knex('config').select('value').where(key: 'apiKey')
			getDeviceID()
			([{value: apiKey}], deviceID) ->
				stateDiff = getStateDiff()
				if _.size(stateDiff) is 0
					return
				resinApi.patch
					resource: 'device'
					id: deviceID
					body: stateDiff
					customOptions:
						apikey: apiKey
				.then ->
					# Update the actual state.
					_.merge(actualState, stateDiff)
				.catch (error) ->
					utils.mixpanelTrack('Device info update failure', {error, stateDiff})
					# Delay 5s before retrying a failed update
					Promise.delay(5000)
		)
		.finally ->
			# Check if any more state diffs have appeared whilst we've been processing this update.
			applyState()

	return (updatedState = {}, retry = false) ->
		# Remove any updates that match the last we successfully sent.
		_.merge(targetState, updatedState)

		# Only trigger applying state if an apply isn't already in progress.
		if !applyPromise.isPending()
			applyState()
		return
