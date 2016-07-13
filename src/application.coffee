_ = require 'lodash'
url = require 'url'
Lock = require 'rwlock'
knex = require './db'
path = require 'path'
config = require './config'
dockerUtils = require './docker-utils'
Promise = require 'bluebird'
utils = require './utils'
logger = require './lib/logger'
{ cachedResinApi } = require './request'
device = require './device'
lockFile = Promise.promisifyAll(require('lockfile'))
bootstrap = require './bootstrap'
TypedError = require 'typed-error'
fs = Promise.promisifyAll(require('fs'))
JSONStream = require 'JSONStream'

class UpdatesLockedError extends TypedError

{ docker } = dockerUtils

logTypes =
	stopApp:
		eventName: 'Application kill'
		humanName: 'Killing application'
	stopAppSuccess:
		eventName: 'Application stop'
		humanName: 'Killed application'
	stopAppError:
		eventName: 'Application stop error'
		humanName: 'Failed to kill application'

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
	updateAppError:
		eventName: 'Application update error'
		humanName: 'Failed to update application'

	appExit:
		eventName: 'Application exit'
		humanName: 'Application exited'

	appRestart:
		eventName: 'Application restart'
		humanName: 'Restarting application'

logSystemMessage = (message, obj, eventName) ->
	logger.log({ m: message, s: true })
	utils.mixpanelTrack(eventName ? message, obj)

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
	logSystemMessage(message, { app, error }, logType.eventName)
	return

logSpecialAction = (action, value, success) ->
	if success
		msg = "Applied config variable #{action} = #{value}"
	else
		msg = "Applying config variable #{action} = #{value}"
	logSystemMessage(msg, {}, "Apply special action #{if success then "success" else "in progress"}")

application = {}

application.kill = kill = (app, updateDB = true, removeContainer = true) ->
	logSystemEvent(logTypes.stopApp, app)
	device.updateState(status: 'Stopping')
	container = docker.getContainer(app.containerId)
	container.stopAsync(t: 10)
	.then ->
		container.removeAsync(v: true) if removeContainer
		return
	# Bluebird throws OperationalError for errors resulting in the normal execution of a promisified function.
	.catch Promise.OperationalError, (err) ->
		# Get the statusCode from the original cause and make sure statusCode its definitely a string for comparison
		# reasons.
		statusCode = '' + err.statusCode
		# 304 means the container was already stopped - so we can just remove it
		if statusCode is '304'
			container.removeAsync(v: true) if removeContainer
			return
		# 404 means the container doesn't exist, precisely what we want! :D
		if statusCode is '404'
			return
		throw err
	.tap ->
		lockFile.unlockAsync(lockPath(app))
	.tap ->
		logSystemEvent(logTypes.stopAppSuccess, app)
		if removeContainer && updateDB
			app.containerId = null
			knex('app').update(app).where(appId: app.appId)
	.catch (err) ->
		logSystemEvent(logTypes.stopAppError, app, err)
		throw err

isValidPort = (port) ->
	maybePort = parseInt(port, 10)
	return parseFloat(port) is maybePort and maybePort > 0 and maybePort < 65535

fetch = (app) ->
	onProgress = (progress) ->
		device.updateState(download_progress: progress.percentage)

	docker.getImage(app.imageId).inspectAsync()
	.catch (error) ->
		logSystemEvent(logTypes.downloadApp, app)
		device.updateState(status: 'Downloading', download_progress: 0)

		Promise.try ->
			JSON.parse(app.env)
		.then (env) ->
			if env['RESIN_SUPERVISOR_DELTA'] == '1'
				dockerUtils.rsyncImageWithProgress(app.imageId, onProgress)
			else
				dockerUtils.fetchImageWithProgress(app.imageId, onProgress)
		.then ->
			logSystemEvent(logTypes.downloadAppSuccess, app)
			device.updateState(status: 'Idle', download_progress: null)
			device.setUpdateState(update_downloaded: true)
			docker.getImage(app.imageId).inspectAsync()
		.catch (err) ->
			logSystemEvent(logTypes.downloadAppError, app, err)
			throw err

shouldMountKmod = (image) ->
	docker.imageRootDir(image)
	.then (rootDir) ->
		utils.getOSVersion(rootDir + '/etc/os-release')
	.then (version) ->
		return version? and (version.match(/^Debian/i) or version.match(/^Raspbian/i))
	.catch (err) ->
		console.error('Error getting app OS release: ', err)
		return false

application.start = start = (app) ->
	volumes = utils.defaultVolumes
	binds = utils.defaultBinds(app.appId)
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
					Volumes: volumes
					Env: _.map env, (v, k) -> k + '=' + v
					ExposedPorts: ports
				)
				.tap ->
					logSystemEvent(logTypes.installAppSuccess, app)
				.catch (err) ->
					logSystemEvent(logTypes.installAppError, app, err)
					throw err
		.tap (container) ->
			logSystemEvent(logTypes.startApp, app)
			device.updateState(status: 'Starting')
			ports = {}
			if portList?
				portList.forEach (port) ->
					ports[port + '/tcp'] = [ HostPort: port ]
			restartPolicy = createRestartPolicy({ name: env['RESIN_APP_RESTART_POLICY'], maximumRetryCount: env['RESIN_APP_RESTART_RETRIES'] })
			shouldMountKmod(app.imageId)
			.then (shouldMount) ->
				binds.push('/bin/kmod:/bin/kmod:ro') if shouldMount
				container.startAsync(
					Privileged: true
					NetworkMode: 'host'
					PortBindings: ports
					Binds: binds
					RestartPolicy: restartPolicy
				)
			.catch (err) ->
				statusCode = '' + err.statusCode
				# 304 means the container was already started, precisely what we want :)
				if statusCode is '304'
					return
				# If starting the container failed, we remove it so that it doesn't litter
				container.removeAsync(v: true)
				.then ->
					app.containerId = null
					knex('app').update(app).where(appId: app.appId)
				.finally ->
					logSystemEvent(logTypes.startAppError, app, err)
					throw err
			.then ->
				app.containerId = container.id
				device.updateState(commit: app.commit)
				logger.attach(app)
		.tap (container) ->
			# Update the app info, only if starting the container worked.
			knex('app').update(app).where(appId: app.appId)
			.then (affectedRows) ->
				knex('app').insert(app) if affectedRows == 0
	.tap ->
		logSystemEvent(logTypes.startAppSuccess, app)
	.finally ->
		device.updateState(status: 'Idle')

validRestartPolicies = [ 'no', 'always', 'on-failure', 'unless-stopped' ]
# Construct a restart policy based on its name and maximumRetryCount.
# Both arguments are optional, and the default policy is "always".
#
# Throws exception if an invalid policy name is given.
# Returns a RestartPolicy { Name, MaximumRetryCount } object
createRestartPolicy = ({ name, maximumRetryCount }) ->
	if not name?
		name = 'always'
	if not (name in validRestartPolicies)
		throw new Error("Invalid restart policy: #{name}")
	policy = { Name: name }
	if name is 'on-failure' and maximumRetryCount?
		policy.MaximumRetryCount = maximumRetryCount
	return policy

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

lockPath = (app) ->
	appId = app.appId ? app
	return "/mnt/root#{config.dataPath}/#{appId}/resin-updates.lock"

killmePath = (app) ->
	appId = app.appId ? app
	return "/mnt/root#{config.dataPath}/#{appId}/resin-kill-me"

# At boot, all apps should be unlocked *before* start to prevent a deadlock
application.unlockAndStart = unlockAndStart = (app) ->
	lockFile.unlockAsync(lockPath(app))
	.then ->
		start(app)

ENOENT = (err) -> err.code is 'ENOENT'

application.lockUpdates = lockUpdates = do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	return (app, force) ->
		lockName = lockPath(app)
		_writeLock(lockName)
		.tap (release) ->
			if force != true
				lockFile.lockAsync(lockName)
				.catch ENOENT, _.noop
				.catch (err) ->
					release()
					throw new UpdatesLockedError("Updates are locked: #{err.message}")
		.disposer (release) ->
			Promise.try ->
				lockFile.unlockAsync(lockName) if force != true
			.finally ->
				release()

joinErrorMessages = (failures) ->
	s = if failures.length > 1 then 's' else ''
	messages = _.map failures, (err) ->
		err.message or err
	"#{failures.length} error#{s}: #{messages.join(' - ')}"

# Function to start the application update polling
application.poll = ->
	updateStatus.intervalHandle = setInterval(->
		application.update()
	, config.appUpdatePollInterval)

# Callback function to set the API poll interval dynamically.
apiPollInterval = (val) ->
	config.appUpdatePollInterval = config.checkInt(val) ? 60000
	console.log('New API poll interval: ' + val)
	clearInterval(updateStatus.intervalHandle)
	application.poll()

specialActionEnvVars =
	'RESIN_OVERRIDE_LOCK': null # This one is in use, so we keep backwards comp.
	'RESIN_SUPERVISOR_DELTA': null
	'RESIN_SUPERVISOR_UPDATE_STRATEGY': null
	'RESIN_SUPERVISOR_HANDOVER_TIMEOUT': null
	'RESIN_SUPERVISOR_OVERRIDE_LOCK': null
	'RESIN_SUPERVISOR_VPN_CONTROL': utils.vpnControl
	'RESIN_SUPERVISOR_CONNECTIVITY_CHECK': utils.enableConnectivityCheck
	'RESIN_SUPERVISOR_POLL_INTERVAL': apiPollInterval
	'RESIN_SUPERVISOR_LOG_CONTROL': utils.resinLogControl

executedSpecialActionEnvVars = {}

executeSpecialActionsAndHostConfig = (env) ->
	Promise.try ->
		_.map specialActionEnvVars, (specialActionCallback, key) ->
			if env[key]? && specialActionCallback?
				# This makes the Special Action Envs only trigger their functions once.
				if !_.has(executedSpecialActionEnvVars, key) or executedSpecialActionEnvVars[key] != env[key]
					logSpecialAction(key, env[key])
					specialActionCallback(env[key])
					executedSpecialActionEnvVars[key] = env[key]
					logSpecialAction(key, env[key], true)
		hostConfigVars = _.pick env, (val, key) ->
			return _.startsWith(key, device.hostConfigEnvVarPrefix)
		if !_.isEmpty(hostConfigVars)
			device.setHostConfig(hostConfigVars, logSystemMessage)

wrapAsError = (err) ->
	return err if _.isError(err)
	return new Error(err.message ? err)

# Wait for app to signal it's ready to die, or timeout to complete.
# timeout defaults to 1 minute.
waitToKill = (app, timeout) ->
	startTime = Date.now()
	pollInterval = 100
	timeout = parseInt(timeout)
	timeout = 60000 if isNaN(timeout)
	checkFileOrTimeout = ->
		fs.statAsync(killmePath(app))
		.catch (err) ->
			throw err unless (Date.now() - startTime) > timeout
		.then ->
			fs.unlinkAsync(killmePath(app)).catch(_.noop)
	retryCheck = ->
		checkFileOrTimeout()
		.catch ->
			Promise.delay(pollInterval).then(retryCheck)
	retryCheck()

UPDATE_IDLE = 0
UPDATE_UPDATING = 1
UPDATE_REQUIRED = 2

updateStatus =
	state: UPDATE_IDLE
	failed: 0
	forceNext: false
	intervalHandle: null

updateStrategies =
	'download-then-kill': ({ localApp, app, needsDownload, force }) ->
		Promise.try ->
			fetch(app) if needsDownload
		.then ->
			Promise.using lockUpdates(localApp, force), ->
				logSystemEvent(logTypes.updateApp, app) if localApp.imageId == app.imageId
				utils.getKnexApp(localApp.appId)
				.then(kill)
				.then ->
					start(app)
			.catch (err) ->
				logSystemEvent(logTypes.updateAppError, app, err) unless err instanceof UpdatesLockedError
				throw err
	'kill-then-download': ({ localApp, app, needsDownload, force }) ->
		Promise.using lockUpdates(localApp, force), ->
			logSystemEvent(logTypes.updateApp, app) if localApp.imageId == app.imageId
			utils.getKnexApp(localApp.appId)
			.then(kill)
			.then ->
				fetch(app) if needsDownload
			.then ->
				start(app)
		.catch (err) ->
			logSystemEvent(logTypes.updateAppError, app, err) unless err instanceof UpdatesLockedError
			throw err
	'hand-over': ({ localApp, app, needsDownload, force, timeout }) ->
		Promise.using lockUpdates(localApp, force), ->
			utils.getKnexApp(localApp.appId)
			.then (localApp) ->
				Promise.try ->
					fetch(app) if needsDownload
				.then ->
					logSystemEvent(logTypes.updateApp, app) if localApp.imageId == app.imageId
					start(app)
				.then ->
					waitToKill(localApp, timeout)
				.then ->
					kill(localApp, false)
		.catch (err) ->
			logSystemEvent(logTypes.updateAppError, app, err) unless err instanceof UpdatesLockedError
			throw err


updateUsingStrategy = (strategy, options) ->
	if not _.has(updateStrategies, strategy)
		strategy = 'download-then-kill'
	updateStrategies[strategy](options)

getRemoteApps = (uuid, apiKey) ->
	cachedResinApi.get
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

getEnvAndFormatRemoteApps = (deviceId, remoteApps, uuid, apiKey) ->
	Promise.map remoteApps, (app) ->
		getEnvironment(app.id, deviceId, apiKey)
		.then (environment) ->
			app.environment_variable = environment
			utils.extendEnvVars(app.environment_variable, uuid, app.id)
		.then (fullEnv) ->
			env = _.omit(fullEnv, _.keys(specialActionEnvVars))
			env = _.omit env, (v, k) ->
				_.startsWith(k, device.hostConfigEnvVarPrefix)
			return [
				{
					appId: '' + app.id
					env: fullEnv
				},
				{
					appId: '' + app.id
					commit: app.commit
					imageId: "#{config.registryEndpoint}/#{path.basename(app.git_repository, '.git')}/#{app.commit}"
					env: JSON.stringify(env) # The env has to be stored as a JSON string for knex
				}
			]
	.then(_.flatten)
	.then(_.zip)
	.then ([ remoteAppEnvs, remoteApps ]) ->
		return [_.mapValues(_.indexBy(remoteAppEnvs, 'appId'), 'env'), _.indexBy(remoteApps, 'appId')]

formatLocalApps = (apps) ->
	apps = _.indexBy(apps, 'appId')
	localAppEnvs = {}
	localApps = _.mapValues apps, (app) ->
		localAppEnvs[app.appId] = JSON.parse(app.env)
		app.env = _.omit localAppEnvs[app.appId], (v, k) ->
			_.startsWith(k, device.hostConfigEnvVarPrefix)
		app.env = JSON.stringify(_.omit(app.env, _.keys(specialActionEnvVars)))
		app = _.pick(app, [ 'appId', 'commit', 'imageId', 'env' ])
	return { localApps, localAppEnvs }

compareForUpdate = (localApps, remoteApps, localAppEnvs, remoteAppEnvs) ->
	remoteAppIds = _.keys(remoteApps)
	localAppIds = _.keys(localApps)
	appsWithChangedEnvs = _.filter remoteAppIds, (appId) ->
		return !localAppEnvs[appId]? or !_.isEqual(remoteAppEnvs[appId], localAppEnvs[appId])
	toBeRemoved = _.difference(localAppIds, remoteAppIds)
	toBeInstalled = _.difference(remoteAppIds, localAppIds)

	toBeUpdated = _.intersection(remoteAppIds, localAppIds)
	toBeUpdated = _.filter toBeUpdated, (appId) ->
		return !_.isEqual(remoteApps[appId], localApps[appId])

	toBeDownloaded = _.filter toBeUpdated, (appId) ->
		return !_.isEqual(remoteApps[appId].imageId, localApps[appId].imageId)
	toBeDownloaded = _.union(toBeDownloaded, toBeInstalled)
	allAppIds = _.union(localAppIds, remoteAppIds)
	return { toBeRemoved, toBeDownloaded, toBeInstalled, toBeUpdated, appsWithChangedEnvs, allAppIds }

application.update = update = (force) ->
	if updateStatus.state isnt UPDATE_IDLE
		# Mark an update required after the current.
		updateStatus.forceNext = force
		updateStatus.state = UPDATE_REQUIRED
		return
	updateStatus.state = UPDATE_UPDATING
	bootstrap.done.then ->
		Promise.join utils.getConfig('apiKey'), utils.getConfig('uuid'), knex('app').select(), (apiKey, uuid, apps) ->
			deviceId = device.getID()
			remoteApps = getRemoteApps(uuid, apiKey)

			Promise.join deviceId, remoteApps, uuid, apiKey, getEnvAndFormatRemoteApps
			.then ([ remoteAppEnvs, remoteApps ]) ->
				{ localApps, localAppEnvs } = formatLocalApps(apps)
				resourcesForUpdate = compareForUpdate(localApps, remoteApps, localAppEnvs, remoteAppEnvs)
				{ toBeRemoved, toBeDownloaded, toBeInstalled, toBeUpdated, appsWithChangedEnvs, allAppIds } = resourcesForUpdate

				if !_.isEmpty(toBeRemoved) or !_.isEmpty(toBeInstalled) or !_.isEmpty(toBeUpdated)
					device.setUpdateState(update_pending: true)
				# Run special functions against variables if remoteAppEnvs has the corresponding variable function mapping.
				Promise.map appsWithChangedEnvs, (appId) ->
					Promise.using lockUpdates(remoteApps[appId], force), ->
						executeSpecialActionsAndHostConfig(remoteAppEnvs[appId])
						.tap ->
							# If an env var shouldn't cause a restart but requires an action, we should still
							# save the new env to the DB
							if !_.includes(toBeUpdated, appId) and !_.includes(toBeInstalled, appId)
								utils.getKnexApp(appId)
								.then (app) ->
									app.env = JSON.stringify(remoteAppEnvs[appId])
									knex('app').update(app).where({ appId })
						.then (needsReboot) ->
							device.reboot() if needsReboot
					.catch (err) ->
						logSystemEvent(logTypes.updateAppError, remoteApps[appId], err)
				.return(allAppIds)
				.map (appId) ->
					Promise.try ->
						needsDownload = _.includes(toBeDownloaded, appId)
						if _.includes(toBeRemoved, appId)
							Promise.using lockUpdates(localApps[appId], force), ->
								# We get the app from the DB again in case someone restarted it
								# (which would have changed its containerId)
								utils.getKnexApp(appId)
								.then(kill)
								.then ->
									knex('app').where('appId', appId).delete()
							.catch (err) ->
								logSystemEvent(logTypes.updateAppError, app, err)
								throw err
						else if _.includes(toBeInstalled, appId)
							app = remoteApps[appId]
							# Restore the complete environment so that it's persisted in the DB
							app.env = JSON.stringify(remoteAppEnvs[appId])
							Promise.try ->
								fetch(remoteApps[appId]) if needsDownload
							.then ->
								start(app)
						else if _.includes(toBeUpdated, appId)
							app = remoteApps[appId]
							# Restore the complete environment so that it's persisted in the DB
							app.env = JSON.stringify(remoteAppEnvs[appId])
							forceThisApp =
								remoteAppEnvs[appId]['RESIN_SUPERVISOR_OVERRIDE_LOCK'] == '1' ||
								remoteAppEnvs[appId]['RESIN_OVERRIDE_LOCK'] == '1'
							strategy = remoteAppEnvs[appId]['RESIN_SUPERVISOR_UPDATE_STRATEGY']
							timeout = remoteAppEnvs[appId]['RESIN_SUPERVISOR_HANDOVER_TIMEOUT']
							updateUsingStrategy strategy, {
								localApp: localApps[appId]
								app
								needsDownload
								force: force || forceThisApp
								timeout
							}
					.catch(wrapAsError)
		.filter(_.isError)
		.then (failures) ->
			_.each(failures, (err) -> console.error('Error:', err, err.stack))
			throw new Error(joinErrorMessages(failures)) if failures.length > 0
		.then ->
			updateStatus.failed = 0
			device.setUpdateState(update_pending: false, update_downloaded: false, update_failed: false)
			# We cleanup here as we want a point when we have a consistent apps/images state, rather than potentially at a
			# point where we might clean up an image we still want.
			dockerUtils.cleanupContainersAndImages()
		.catch (err) ->
			updateStatus.failed++
			device.setUpdateState(update_failed: true)
			if updateStatus.state is UPDATE_REQUIRED
				console.log('Updating failed, but there is already another update scheduled immediately: ', err)
				return
			delayTime = Math.min((2 ** updateStatus.failed) * 500, 30000)
			# If there was an error then schedule another attempt briefly in the future.
			console.log('Scheduling another update attempt due to failure: ', delayTime, err)
			setTimeout(update, delayTime, force)
		.finally ->
			device.updateState(status: 'Idle')
			if updateStatus.state is UPDATE_REQUIRED
				# If an update is required then schedule it
				setTimeout(update, 1, updateStatus.forceNext)
		.finally ->
			# Set the updating as finished in its own block, so it never has to worry about other code stopping this.
			updateStatus.state = UPDATE_IDLE

listenToEvents = do ->
	appHasDied = {}
	return ->
		docker.getEventsAsync()
		.then (stream) ->
			stream.on 'error', (err) ->
				console.error('Error on docker events stream:', err, err.stack)
			parser = JSONStream.parse()
			parser.on 'error', (err) ->
				console.error('Error on docker events JSON stream:', err, err.stack)
			parser.on 'data', (data) ->
				if data?.Type? && data.Type == 'container' && data.status in ['die', 'start']
					knex('app').select().where({ containerId: data.id })
					.then ([ app ]) ->
						if app?
							if data.status == 'die'
								logSystemEvent(logTypes.appExit, app)
								appHasDied[app.containerId] = true
							else if data.status == 'start' and appHasDied[app.containerId]
								logSystemEvent(logTypes.appRestart, app)
								logger.attach(app)
					.catch (err) ->
						console.error('Error on docker event:', err, err.stack)
			parser.on 'end', ->
				console.error('Docker events stream ended, this should never happen')
				listenToEvents()
			stream.pipe(parser)
		.catch (err) ->
			console.error('Error listening to events:', err, err.stack)

application.initialize = ->
	listenToEvents()
	knex('app').select()
	.then (apps) ->
		Promise.map apps, (app) ->
			executeSpecialActionsAndHostConfig(JSON.parse(app.env))
			.then ->
				unlockAndStart(app)
	.catch (error) ->
		console.error('Error starting apps:', error)
	.then ->
		utils.mixpanelTrack('Start application update poll', { interval: config.appUpdatePollInterval })
		application.poll()
		application.update()

module.exports = (logsChannel, offlineMode) ->
	logger.init(
		dockerSocket: config.dockerSocket
		pubnub: config.pubnub
		channel: "device-#{logsChannel}-logs"
		offlineMode: offlineMode
	)
	return application
