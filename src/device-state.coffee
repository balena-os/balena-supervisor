Promise = require 'bluebird'
_ = require 'lodash'
Lock = require 'rwlock'
EventEmitter = require 'events'
fs = Promise.promisifyAll(require('fs'))
express = require 'express'
bodyParser = require 'body-parser'
hostConfig = require './host-config'
network = require './network'

constants = require './lib/constants'
validation = require './lib/validation'
systemd = require './lib/systemd'
updateLock = require './lib/update-lock'
{ singleToMulticontainerApp } = require './lib/migration'

DeviceConfig = require './device-config'
ApplicationManager = require './application-manager'

validateLocalState = (state) ->
	if !state.name? or !validation.isValidShortText(state.name)
		throw new Error('Invalid device name')
	if !state.apps? or !validation.isValidAppsObject(state.apps)
		throw new Error('Invalid apps')
	if !state.config? or !validation.isValidEnv(state.config)
		throw new Error('Invalid device configuration')

validateDependentState = (state) ->
	if state.apps? and !validation.isValidDependentAppsObject(state.apps)
		throw new Error('Invalid dependent apps')
	if state.devices? and !validation.isValidDependentDevicesObject(state.devices)
		throw new Error('Invalid dependent devices')

validateState = Promise.method (state) ->
	if !_.isObject(state)
		throw new Error('State must be an object')
	if !_.isObject(state.local)
		throw new Error('Local state must be an object')
	validateLocalState(state.local)
	if state.dependent?
		validateDependentState(state.dependent)

# TODO (refactor): This shouldn't be here, and instead should be part of the other
# device api stuff in ./device-api
createDeviceStateRouter = (deviceState) ->
	router = express.Router()
	router.use(bodyParser.urlencoded(extended: true))
	router.use(bodyParser.json())

	rebootOrShutdown = (req, res, action) ->
		deviceState.config.get('lockOverride')
		.then (lockOverride) ->
			force = validation.checkTruthy(req.body.force) or validation.checkTruthy(lockOverride)
			deviceState.executeStepAction({ action }, { force })
		.then (response) ->
			res.status(202).json(response)
		.catch (err) ->
			if err instanceof updateLock.UpdatesLockedError
				status = 423
			else
				status = 500
			res.status(status).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	router.post '/v1/reboot', (req, res) ->
		rebootOrShutdown(req, res, 'reboot')

	router.post '/v1/shutdown', (req, res) ->
		rebootOrShutdown(req, res, 'shutdown')

	router.get '/v1/device/host-config', (req, res) ->
		hostConfig.get()
		.then (conf) ->
			res.json(conf)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	router.patch '/v1/device/host-config', (req, res) ->
		hostConfig.patch(req.body, deviceState.config)
		.then ->
			res.status(200).send('OK')
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	router.get '/v1/device', (req, res) ->
		deviceState.getStatus()
		.then (state) ->
			stateToSend = _.pick(state.local, [
				'api_port'
				'ip_address'
				'os_version'
				'supervisor_version'
				'update_pending'
				'update_failed'
				'update_downloaded'
			])
			if state.local.is_on__commit?
				stateToSend.commit = state.local.is_on__commit
			# Will produce nonsensical results for multicontainer apps...
			service = _.toPairs(_.toPairs(state.local.apps)[0]?[1]?.services)[0]?[1]
			if service?
				stateToSend.status = service.status
				# For backwards compatibility, we adapt Running to the old "Idle"
				if stateToSend.status == 'Running'
					stateToSend.status = 'Idle'
				stateToSend.download_progress = service.download_progress
			res.json(stateToSend)
		.catch (err) ->
			res.status(500).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	router.use(deviceState.applications.router)
	return router

module.exports = class DeviceState extends EventEmitter
	constructor: ({ @db, @config, @eventTracker, @logger }) ->
		@deviceConfig = new DeviceConfig({ @db, @config, @logger })
		@applications = new ApplicationManager({ @config, @logger, @db, @eventTracker, deviceState: this })
		@on 'error', (err) ->
			console.error('Error in deviceState: ', err, err.stack)
		@_currentVolatile = {}
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@_readLock = Promise.promisify(_lock.async.readLock)
		@lastSuccessfulUpdate = null
		@failedUpdates = 0
		@applyInProgress = false
		@lastApplyStart = process.hrtime()
		@scheduledApply = null
		@shuttingDown = false
		@router = createDeviceStateRouter(this)
		@on 'apply-target-state-end', (err) ->
			if err?
				console.log("Apply error #{err}")
			else
				console.log('Apply success!')
		@applications.on('change', @reportCurrentState)

	healthcheck: =>
		@config.getMany([ 'appUpdatePollInterval', 'offlineMode' ])
		.then (conf) =>
			cycleTime = process.hrtime(@lastApplyStart)
			cycleTimeMs = cycleTime[0] * 1000 + cycleTime[1] / 1e6
			cycleTimeWithinInterval = cycleTimeMs - @applications.timeSpentFetching < 2 * conf.appUpdatePollInterval
			applyTargetHealthy = conf.offlineMode or !@applyInProgress or @applications.fetchesInProgress > 0 or cycleTimeWithinInterval
			return applyTargetHealthy

	normaliseLegacy: =>
		# When legacy apps are present, we kill their containers and migrate their /data to a named volume
		# (everything else is handled by the knex migration)
		console.log('Killing legacy containers')
		@applications.services.killAllLegacy()
		.then =>
			console.log('Migrating legacy app volumes')
			@applications.getTargetApps()
			.then(_.keys)
		.map (appId) =>
			@applications.volumes.createFromLegacy(appId)
		.then =>
			@config.set({ legacyAppsPresent: 'false' })

	init: ->
		@config.on 'change', (changedConfig) =>
			if changedConfig.loggingEnabled?
				@logger.enable(validation.checkTruthy(changedConfig.loggingEnabled))
			if changedConfig.apiSecret?
				@reportCurrentState(api_secret: changedConfig.apiSecret)

		@config.getMany([
			'initialConfigSaved', 'listenPort', 'apiSecret', 'osVersion', 'osVariant',
			'version', 'provisioned', 'apiEndpoint', 'connectivityCheckEnabled', 'legacyAppsPresent'
		])
		.then (conf) =>
			Promise.try =>
				if validation.checkTruthy(conf.legacyAppsPresent)
					@normaliseLegacy()
			.then =>
				@applications.init()
			.then =>
				if !validation.checkTruthy(conf.initialConfigSaved)
					@saveInitialConfig()
			.then =>
				@initNetworkChecks(conf)
				console.log('Reporting initial state, supervisor version and API info')
				@reportCurrentState(
					api_port: conf.listenPort
					api_secret: conf.apiSecret
					os_version: conf.osVersion
					os_variant: conf.osVariant
					supervisor_version: conf.version
					provisioning_progress: null
					provisioning_state: ''
					status: 'Idle'
					logs_channel: null
					update_failed: false
					update_pending: false
					update_downloaded: false
				)
			.then =>
				if !conf.provisioned
					@loadTargetFromFile()
			.then =>
				@triggerApplyTarget({ initial: true })

	initNetworkChecks: ({ apiEndpoint, connectivityCheckEnabled }) =>
		network.startConnectivityCheck apiEndpoint, connectivityCheckEnabled, (connected) =>
			@connected = connected
		@config.on 'change', (changedConfig) ->
			if changedConfig.connectivityCheckEnabled?
				network.enableConnectivityCheck(changedConfig.connectivityCheckEnabled)
		console.log('Starting periodic check for IP addresses')
		network.startIPAddressUpdate (addresses) =>
			@reportCurrentState(
				ip_address: addresses.join(' ')
			)
		, constants.ipAddressUpdateInterval

	saveInitialConfig: =>
		@deviceConfig.getCurrent()
		.then (devConf) =>
			@deviceConfig.setTarget(devConf)
		.then =>
			@config.set({ initialConfigSaved: 'true' })

	emitAsync: (ev, args...) =>
		setImmediate => @emit(ev, args...)

	_readLockTarget: =>
		@_readLock('target').disposer (release) ->
			release()
	_writeLockTarget: =>
		@_writeLock('target').disposer (release) ->
			release()
	_inferStepsLock: =>
		@_writeLock('inferSteps').disposer (release) ->
			release()

	usingReadLockTarget: (fn) =>
		Promise.using @_readLockTarget, -> fn()
	usingWriteLockTarget: (fn) =>
		Promise.using @_writeLockTarget, -> fn()
	usingInferStepsLock: (fn) =>
		Promise.using @_inferStepsLock, -> fn()

	setTarget: (target, localSource = false) ->
		Promise.join(
			@config.get('apiEndpoint'),
			validateState(target),
			(apiEndpoint) =>
				source = apiEndpoint
				@usingWriteLockTarget =>
					# Apps, deviceConfig, dependent
					@db.transaction (trx) =>
						Promise.try =>
							@config.set({ name: target.local.name }, trx)
						.then =>
							@deviceConfig.setTarget(target.local.config, trx)
						.then =>
							if localSource
								@applications.setTarget(target.local.apps, target.dependent, 'local', trx)
							else
								@applications.setTarget(target.local.apps, target.dependent, apiEndpoint, trx)
		)

	getTarget: ({ initial = false, intermediate = false } = {}) =>
		@usingReadLockTarget =>
			if intermediate
				return @intermediateTarget
			Promise.props({
				local: Promise.props({
					name: @config.get('name')
					config: @deviceConfig.getTarget({ initial })
					apps: @applications.getTargetApps()
				})
				dependent: @applications.getDependentTargets()
			})

	getStatus: ->
		@applications.getStatus()
		.then (appsStatus) =>
			theState = { local: {}, dependent: {} }
			_.merge(theState.local, @_currentVolatile)
			theState.local.apps = appsStatus.local
			theState.dependent.apps = appsStatus.dependent
			if appsStatus.commit and !@applyInProgress
				theState.local.is_on__commit = appsStatus.commit
			return theState

	getCurrentForComparison: ->
		Promise.join(
			@config.get('name')
			@deviceConfig.getCurrent()
			@applications.getCurrentForComparison()
			@applications.getDependentState()
			(name, devConfig, apps, dependent) ->
				return {
					local: {
						name
						config: devConfig
						apps
					}
					dependent
				}
		)

	reportCurrentState: (newState = {}) =>
		_.assign(@_currentVolatile, newState)
		@emitAsync('change')

	_convertLegacyAppsJson: (appsArray) =>
		config = _.reduce(appsArray, (conf, app) =>
			return _.merge({}, conf, @deviceConfig.filterConfigKeys(app.config))
		, {})
		apps = _.keyBy(_.map(appsArray, singleToMulticontainerApp), 'appId')
		return { apps, config }

	loadTargetFromFile: (appsPath) ->
		appsPath ?= constants.appsJsonPath
		fs.readFileAsync(appsPath, 'utf8')
		.then(JSON.parse)
		.then (stateFromFile) =>
			commitToPin = null
			appToPin = null
			if !_.isEmpty(stateFromFile)
				if _.isArray(stateFromFile)
					# This is a legacy apps.json
					stateFromFile = @_convertLegacyAppsJson(stateFromFile)
				images = _.flatMap stateFromFile.apps, (app, appId) =>
					# multi-app warning!
					# The following will need to be changed once running multiple applications is possible
					commitToPin = app.commit
					appToPin = appId
					_.map app.services, (service, serviceId) =>
						svc = {
							imageName: service.image
							serviceName: service.serviceName
							imageId: service.imageId
							serviceId
							releaseId: app.releaseId
							appId
						}
						return @applications.imageForService(svc)
				Promise.map images, (img) =>
					@applications.images.normalise(img.name)
					.then (name) =>
						img.name = name
						@applications.images.save(img)
				.then =>
					@deviceConfig.getCurrent()
				.then (deviceConf) =>
					_.defaults(stateFromFile.config, deviceConf)
					stateFromFile.name ?= ''
					@setTarget({
						local: stateFromFile
					})
				.then =>
					if stateFromFile.pinDevice
						# multi-app warning!
						# The following will need to be changed once running multiple applications is possible
						if commitToPin? and appToPin?
							@config.set
								pinDevice: JSON.stringify {
									commit: commitToPin,
									app: appToPin,
								}
		.catch (err) =>
			@eventTracker.track('Loading preloaded apps failed', { error: err })

	reboot: (force, skipLock) =>
		@applications.stopAll({ force, skipLock })
		.then =>
			@logger.logSystemMessage('Rebooting', {}, 'Reboot')
			systemd.reboot()
		.tap =>
			@shuttingDown = true
			@emitAsync('shutdown')

	shutdown: (force, skipLock) =>
		@applications.stopAll({ force, skipLock })
		.then =>
			@logger.logSystemMessage('Shutting down', {}, 'Shutdown')
			systemd.shutdown()
		.tap =>
			@shuttingDown = true
			@emitAsync('shutdown')

	executeStepAction: (step, { force, initial, skipLock }) =>
		Promise.try =>
			if _.includes(@deviceConfig.validActions, step.action)
				@deviceConfig.executeStepAction(step, { initial })
			else if _.includes(@applications.validActions, step.action)
				@applications.executeStepAction(step, { force, skipLock })
			else
				switch step.action
					when 'reboot'
						# There isn't really a way that these methods can fail,
						# and if they do, we wouldn't know about it until after
						# the response has been sent back to the API. Just return
						# "OK" for this and the below action
						@reboot(force, skipLock).return(Data: 'OK', Error: null)
					when 'shutdown'
						@shutdown(force, skipLock).return(Data: 'OK', Error: null)
					when 'noop'
						Promise.resolve()
					else
						throw new Error("Invalid action #{step.action}")

	applyStep: (step, { force, initial, intermediate, skipLock }) =>
		if @shuttingDown
			return
		@executeStepAction(step, { force, initial, skipLock })
		.tapCatch (err) =>
			@emitAsync('step-error', err, step)
		.then (stepResult) =>
			@emitAsync('step-completed', null, step, stepResult)

	applyError: (err, { force, initial, intermediate }) =>
		@emitAsync('apply-target-state-error', err)
		@emitAsync('apply-target-state-end', err)
		if intermediate
			throw err
		@failedUpdates += 1
		@reportCurrentState(update_failed: true)
		if @scheduledApply?
			console.log("Updating failed, but there's another update scheduled immediately: ", err)
		else
			delay = Math.min((2 ** @failedUpdates) * 500, 30000)
			# If there was an error then schedule another attempt briefly in the future.
			console.log('Scheduling another update attempt due to failure: ', delay, err)
			@triggerApplyTarget({ force, delay, initial })

	applyTarget: ({ force = false, initial = false, intermediate = false, skipLock = false } = {}) =>
		nextDelay = 200
		Promise.try =>
			if !intermediate
				@applyBlocker
		.then =>
			@usingInferStepsLock =>
				Promise.join(
					@getCurrentForComparison()
					@getTarget({ initial, intermediate })
					(currentState, targetState) =>
						@deviceConfig.getRequiredSteps(currentState, targetState)
						.then (deviceConfigSteps) =>
							if !_.isEmpty(deviceConfigSteps)
								return deviceConfigSteps
							else
								@applications.getRequiredSteps(currentState, targetState, intermediate)
				)
		.then (steps) =>
			if _.isEmpty(steps)
				@emitAsync('apply-target-state-end', null)
				if !intermediate
					console.log('Finished applying target state')
					@applications.timeSpentFetching = 0
					@failedUpdates = 0
					@lastSuccessfulUpdate = Date.now()
					@reportCurrentState(update_failed: false, update_pending: false, update_downloaded: false)
				return
			if !intermediate
				@reportCurrentState(update_pending: true)
			if _.every(steps, (step) -> step.action == 'noop')
				nextDelay = 1000
			Promise.map steps, (step) =>
				@applyStep(step, { force, initial, intermediate, skipLock })
			.delay(nextDelay)
			.then =>
				@applyTarget({ force, initial, intermediate, skipLock })
		.catch (err) =>
			@applyError(err, { force, initial, intermediate })

	pausingApply: (fn) =>
		lock = =>
			@_writeLock('pause').disposer (release) ->
				release()
		pause = =>
			Promise.try =>
				res = null
				@applyBlocker = new Promise (resolve) ->
					res = resolve
				return res
			.disposer (resolve) ->
				resolve()

		Promise.using lock(), ->
			Promise.using pause(), ->
				fn()

	resumeNextApply: =>
		@applyUnblocker?()
		return

	triggerApplyTarget: ({ force = false, delay = 0, initial = false } = {}) =>
		if @applyInProgress
			console.log('==> Apply in progress')
			if !@scheduledApply?
				@scheduledApply = { force, delay }
			else
				# If a delay has been set it's because we need to hold off before applying again,
				# so we need to respect the maximum delay that has been passed
				@scheduledApply.delay = Math.max(delay, @scheduledApply.delay)
				@scheduledApply.force or= force
			return
		@applyInProgress = true
		Promise.delay(delay)
		.then =>
			@lastApplyStart = process.hrtime()
			console.log('Applying target state')
			@applyTarget({ force, initial })
		.finally =>
			console.log('==> Done applying target state!')
			@applyInProgress = false
			@reportCurrentState()
			if @scheduledApply?
				@triggerApplyTarget(@scheduledApply)
				@scheduledApply = null
		return null

	applyIntermediateTarget: (intermediateTarget, { force = false, skipLock = false } = {}) =>
		@intermediateTarget = _.cloneDeep(intermediateTarget)
		@applyTarget({ intermediate: true, force, skipLock })
		.then =>
			@intermediateTarget = null
