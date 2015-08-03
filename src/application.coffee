_ = require 'lodash'
url = require 'url'
Lock = require 'rwlock'
knex = require './db'
path = require 'path'
config = require './config'
dockerUtils = require './docker-utils'
Promise = require 'bluebird'
utils = require './utils'
tty = require './lib/tty'
logger = require './lib/logger'
{ cachedResinApi } = require './request'
device = require './device'

{ docker } = dockerUtils

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
	stopAppError:
		eventName: 'Application stop error'
		humanName: 'Killed application'

	downloadApp:
		eventName: 'Application download'
		humanName: 'Downloading application'
	downloadAppSuccess:
		eventName: 'Application downloaded'
		humanName: 'Downloaded application'
	downloadAppError:
		eventName: 'Application download error'
		humanName: 'Failed to download application'

	installApp:
		eventName: 'Application install'
		humanName: 'Installing application'
	installAppSuccess:
		eventName: 'Application installed'
		humanName: 'Installed application'
	installAppError:
		eventName: 'Application install error'
		humanName: 'Failed to install application'

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

logSystemEvent = (logType, app, error) ->
	message = "#{logType.humanName} '#{app.imageId}'"
	if error?
		# Report the message from the original cause to the user.
		errMessage = error.json
		if _.isEmpty(errMessage)
			errMessage = error.reason
		if _.isEmpty(errMessage)
			errMessage = error.message
		if _.isEmpty(errMessage)
			errMessage = 'Unknown cause'
		message += " due to '#{errMessage}'"
	logger.log({ message, isSystem: true })
	utils.mixpanelTrack(logType.eventName, {app, error})
	return

exports.kill = kill = (app) ->
	logSystemEvent(logTypes.stopApp, app)
	device.updateState(status: 'Stopping')
	container = docker.getContainer(app.containerId)
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
		statusCode = '' + err.statusCode
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
	.catch (err) ->
		logSystemEvent(logTypes.stopAppError, app, err)
		throw err

isValidPort = (port) ->
	maybePort = parseInt(port, 10)
	return parseFloat(port) is maybePort and maybePort > 0 and maybePort < 65535

fetch = (app) ->
	docker.getImage(app.imageId).inspectAsync()
	.catch (error) ->
		logSystemEvent(logTypes.downloadApp, app)
		device.updateState(status: 'Downloading')
		dockerUtils.fetchImageWithProgress app.imageId, (progress) ->
			device.updateState(download_progress: progress.percentage)
		.then ->
			logSystemEvent(logTypes.downloadAppSuccess, app)
			device.updateState(download_progress: null)
			docker.getImage(app.imageId).inspectAsync()
		.catch (err) ->
			logSystemEvent(logTypes.downloadAppError, app, err)
			throw err

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
				device.updateState(status: 'Installing')

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
						'/lib/firmware': {}
						'/run/dbus': {}
					Env: _.map env, (v, k) -> k + '=' + v
					ExposedPorts: ports
				)
				.tap ->
					logSystemEvent(logTypes.installAppSuccess, app)
				.catch (err) ->
					logSystemEvent(logTypes.installAppError, app, err)
					throw err
		.tap (container) ->
			# Update the app info the moment we create the container, even if then starting the container fails. This
			# stops issues with constantly creating new containers for an image that fails to start.
			app.containerId = container.id
			if app.id?
				knex('app').update(app).where(id: app.id)
			else
				knex('app').insert(app)
		.tap (container) ->
			logSystemEvent(logTypes.startApp, app)
			device.updateState(status: 'Starting')
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
					'/lib/firmware:/lib/firmware'
					'/run/dbus:/run/dbus'
					'/var/run/docker.sock:/run/docker.sock'
					'/etc/resolv.conf:/etc/resolv.conf:rw'
				]
			)
			.catch (err) ->
				statusCode = '' + err.statusCode
				# 304 means the container was already started, precisely what we want :)
				if statusCode is '304'
					return
				logSystemEvent(logTypes.startAppError, app, err)
				throw err
			.then ->
				device.updateState(commit: app.commit)
				logger.attach(app)
	.tap ->
		logSystemEvent(logTypes.startAppSuccess, app)
	.finally ->
		device.updateState(status: 'Idle')

getEnvironment = do ->
	envApiEndpoint = url.resolve(config.apiEndpoint, '/environment')

	return (appId, deviceId, apiKey) ->

		requestParams = _.extend
			method: 'GET'
			url: "#{envApiEndpoint}?deviceId=#{deviceId}&appId=#{appId}&apikey=#{apiKey}"
		, cachedResinApi.passthrough

		cachedResinApi._request(requestParams)
		.catch (err) ->
			console.error("Failed to get environment for device #{deviceId}, app #{appId}. #{err}")
			throw err

lock = new Lock()
exports.lockUpdates = lockUpdates = lock.async.writeLock
exports.lockUpdatesAsync = lockUpdatesAsync = Promise.promisify(lockUpdates)

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

		deviceId = device.getID()

		remoteApps = cachedResinApi.get
			resource: 'application'
			options:
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

		Promise.join deviceId, remoteApps, (deviceId, remoteApps) ->
			return Promise.map remoteApps, (remoteApp) ->
				getEnvironment(remoteApp.id, deviceId, apiKey)
				.then (environment) ->
					remoteApp.environment_variable = environment
					return remoteApp
		.then (remoteApps) ->
			remoteApps = _.map remoteApps, (app) ->
				env =
					RESIN_DEVICE_UUID: uuid
					RESIN: '1'
					USER: 'root'

				if app.environment_variable?
					_.extend(env, app.environment_variable)
				return {
					appId: '' + app.id
					commit: app.commit
					imageId: "#{config.registryEndpoint}/#{path.basename(app.git_repository, '.git')}/#{app.commit}"
					env: JSON.stringify(env) # The env has to be stored as a JSON string for knex
				}

			remoteApps = _.indexBy(remoteApps, 'imageId')
			remoteImages = _.keys(remoteApps)

			apps = _.indexBy(apps, 'imageId')
			localApps = _.mapValues apps, (app) ->
				_.pick(app, [ 'appId', 'commit', 'imageId', 'env' ])
			localImages = _.keys(localApps)

			toBeRemoved = _.difference(localImages, remoteImages)
			toBeInstalled = _.difference(remoteImages, localImages)

			toBeUpdated = _.intersection(remoteImages, localImages)
			toBeUpdated = _.filter toBeUpdated, (imageId) ->
				return !_.isEqual(remoteApps[imageId], localApps[imageId])

			# Fetch any updated images first
			Promise.map toBeInstalled, (imageId) ->
				app = remoteApps[imageId]
				fetch(app)
			.then ->
				lockUpdatesAsync()
			.tap ->
				# Then delete all the ones to remove in one go
				Promise.map toBeRemoved, (imageId) ->
					kill(apps[imageId])
			.tap ->
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
			.then (release) ->
				release()
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
		device.updateState(status: 'Idle')
		if currentlyUpdating is 2
			# If an update is required then schedule it
			setTimeout(update)
	.finally ->
		# Set the updating as finished in its own block, so it never has to worry about other code stopping this.
		currentlyUpdating = 0
