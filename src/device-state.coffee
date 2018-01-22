Promise = require 'bluebird'
_ = require 'lodash'
Lock = require 'rwlock'
EventEmitter = require 'events'
fs = Promise.promisifyAll(require('fs'))
express = require 'express'
bodyParser = require 'body-parser'

network = require './network'

constants = require './lib/constants'
validation = require './lib/validation'
device = require './lib/device'
updateLock = require './lib/update-lock'

DeviceConfig = require './device-config'
Logger = require './logger'
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

singleToMulticontainerApp = (app) ->
	environment = {}
	for key of app.env
		if !/^RESIN_/.test(key)
			environment[key] = app.env[key]

	appId = app.appId
	conf = app.config ? {}
	newApp = {
		appId: appId
		commit: app.commit
		name: app.name
		releaseId: 1
		networks: {}
		volumes: {}
	}
	defaultVolume = "resin-app-#{appId}"
	newApp.volumes[defaultVolume] = {}
	updateStrategy = conf['RESIN_SUPERVISOR_UPDATE_STRATEGY']
	if updateStrategy == null
		updateStrategy = 'download-then-kill'
	handoverTimeout = conf['RESIN_SUPERVISOR_HANDOVER_TIMEOUT']
	if handoverTimeout == null
		handoverTimeout = ''
	restartPolicy = conf['RESIN_APP_RESTART_POLICY']
	if restartPolicy == null
		restartPolicy = 'always'

	newApp.services = [
		{
			serviceId: 1
			appId: appId
			serviceName: app.name.toLowerCase()
			imageId: 1
			commit: app.commit
			releaseId: 1
			image: app.imageId
			privileged: true
			networkMode: 'host'
			volumes: [
				"#{defaultVolume}:/data"
			],
			labels: {
				'io.resin.features.kernel-modules': '1'
				'io.resin.features.firmware': '1'
				'io.resin.features.dbus': '1',
				'io.resin.features.supervisor-api': '1'
				'io.resin.features.resin-api': '1'
				'io.resin.update.strategy': updateStrategy
				'io.resin.update.handover-timeout': handoverTimeout
				'io.resin.legacy-container': '1'
			},
			environment: environment
			restart: restartPolicy
			running: true
		}
	]
	return newApp

class DeviceStateRouter
	constructor: (@deviceState) ->
		{ @applications } = @deviceState
		@router = express.Router()
		@router.use(bodyParser.urlencoded(extended: true))
		@router.use(bodyParser.json())

		@router.post '/v1/reboot', (req, res) =>
			force = validation.checkTruthy(req.body.force)
			@deviceState.executeStepAction({ action: 'reboot' }, { force })
			.then (response) ->
				res.status(202).json(response)
			.catch (err) ->
				if err instanceof updateLock.UpdatesLockedError
					status = 423
				else
					status = 500
				res.status(status).json({ Data: '', Error: err?.message or err or 'Unknown error' })

		@router.post '/v1/shutdown', (req, res) =>
			force = validation.checkTruthy(req.body.force)
			@deviceState.executeStepAction({ action: 'shutdown' }, { force })
			.then (response) ->
				res.status(202).json(response)
			.catch (err) ->
				if err instanceof updateLock.UpdatesLockedError
					status = 423
				else
					status = 500
				res.status(status).json({ Data: '', Error: err?.message or err or 'Unknown error' })

		@router.get '/v1/device', (req, res) =>
			@deviceState.getStatus()
			.then (state) ->
				stateToSend = _.pick(state.local, [
					'api_port'
					'commit'
					'ip_address'
					'status'
					'download_progress'
					'os_version'
					'supervisor_version'
					'update_pending'
					'update_failed'
					'update_downloaded'
				])
				res.json(stateToSend)
			.catch (err) ->
				res.status(500).json({ Data: '', Error: err?.message or err or 'Unknown error' })

		@router.use(@applications.router)

module.exports = class DeviceState extends EventEmitter
	constructor: ({ @db, @config, @eventTracker }) ->
		@logger = new Logger({ @eventTracker })
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
		@_router = new DeviceStateRouter(this)
		@router = @_router.router
		@on 'apply-target-state-end', (err) ->
			if err?
				console.log("Apply error #{err}")
			else
				console.log('Apply success!')
		@on 'step-completed', (err) ->
			if err?
				console.log("Step completed with error #{err}")
			else
				console.log('Step success!')
		@on 'step-error', (err) ->
			console.log("Step error #{err}")

		@applications.on('change', @reportCurrentState)

	healthcheck: =>
		@config.getMany([ 'appUpdatePollInterval', 'offlineMode' ])
		.then (conf) =>
			cycleTimeWithinInterval = process.hrtime(@lastApplyStart)[0] - @applications.timeSpentFetching < 2 * conf.appUpdatePollInterval
			applyTargetHealthy = conf.offlineMode or !@applyInProgress or @applications.fetchesInProgress > 0 or cycleTimeWithinInterval
			return applyTargetHealthy and @deviceConfig.gosuperHealthy

	normaliseLegacy: =>
		# When legacy apps are present, we kill their containers and migrate their /data to a named volume
		# (everything else is handled by the knex migration)
		console.log('Killing legacy containers')
		@applications.services.killAllLegacy()
		.then =>
			console.log('Migrating legacy app volumes')
			@applications.getTargetApps()
			.map (app) =>
				@applications.volumes.createFromLegacy(app.appId)
		.then =>
			@config.set({ legacyAppsPresent: 'false' })

	init: ->
		@config.getMany([
			'logsChannelSecret', 'pubnub', 'offlineMode', 'loggingEnabled', 'initialConfigSaved',
			'listenPort', 'apiSecret', 'osVersion', 'osVariant', 'version', 'provisioned',
			'resinApiEndpoint', 'connectivityCheckEnabled', 'legacyAppsPresent'
		])
		.then (conf) =>
			@logger.init({
				pubnub: conf.pubnub
				channel: "device-#{conf.logsChannelSecret}-logs"
				offlineMode: conf.offlineMode
				enable: conf.loggingEnabled
			})
			.then =>
				@config.on 'change', (changedConfig) =>
					if changedConfig.loggingEnabled?
						@logger.enable(changedConfig.loggingEnabled)
					if changedConfig.apiSecret?
						@reportCurrentState(api_secret: changedConfig.apiSecret)
			.then =>
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
					logs_channel: conf.logsChannelSecret
					update_failed: false
					update_pending: false
					update_downloaded: false
				)
			.then =>
				if !conf.provisioned
					@loadTargetFromFile()
			.then =>
				@triggerApplyTarget({ initial: true })

	initNetworkChecks: ({ resinApiEndpoint, connectivityCheckEnabled }) =>
		network.startConnectivityCheck resinApiEndpoint, connectivityCheckEnabled, (connected) =>
			@connected = connected
		@config.on 'change', (changedConfig) ->
			if changedConfig.connectivityCheckEnabled?
				network.enableConnectivityCheck(changedConfig.connectivityCheckEnabled)
		console.log('Starting periodic check for IP addresses')
		network.startIPAddressUpdate (addresses) =>
			@reportCurrentState(
				ip_address: addresses.join(' ')
			)
		, @config.constants.ipAddressUpdateInterval

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

	setTarget: (target) ->
		validateState(target)
		.then =>
			@usingWriteLockTarget =>
				# Apps, deviceConfig, dependent
				@db.transaction (trx) =>
					Promise.try =>
						@config.set({ name: target.local.name }, trx)
					.then =>
						@deviceConfig.setTarget(target.local.config, trx)
					.then =>
						@applications.setTarget(target.local.apps, target.dependent, trx)

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
			if appsStatus.commit
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

	_convertLegacyAppsJson: (appsArray) ->
		config = _.reduce(appsArray, (conf, app) ->
			return _.merge({}, conf, @deviceConfig.filterConfigKeys(app.config))
		, {})
		apps = _.map(appsArray, singleToMulticontainerApp)
		return { apps, config }

	loadTargetFromFile: (appsPath) ->
		appsPath ?= constants.appsJsonPath
		fs.readFileAsync(appsPath, 'utf8')
		.then(JSON.parse)
		.then (stateFromFile) =>
			if !_.isEmpty(stateFromFile)
				if _.isArray(stateFromFile)
					# This is a legacy apps.json
					stateFromFile = @_convertLegacyAppsJson(stateFromFile)
				images = _.flatten(_.map(_.values(stateFromFile.apps), (app, appId) =>
					_.map app.services, (service, serviceId) =>
						svc = {
							image: service.image
							serviceName: service.serviceName
							imageId: service.imageId
							serviceId
							appId
						}
						return @applications.imageForService(svc)
				))
				Promise.map images, (img) =>
					@applications.images.normalise(img.name)
					.then (name) =>
						img.name = name
						@applications.images.save(img)
				.then =>
					@deviceConfig.getCurrent()
					.then (deviceConf) ->
						_.defaults(stateFromFile.config, deviceConf)
						@setTarget({
							local: stateFromFile
						})
		.catch (err) =>
			@eventTracker.track('Loading preloaded apps failed', { error: err })

	reboot: (force) =>
		@applications.stopAll({ force })
		.then =>
			@logger.logSystemMessage('Rebooting', {}, 'Reboot')
			device.reboot()
			.tap =>
				@emit('shutdown')

	shutdown: (force) =>
		@applications.stopAll({ force })
		.then =>
			@logger.logSystemMessage('Shutting down', {}, 'Shutdown')
			device.shutdown()
			.tap =>
				@shuttingDown = true
				@emitAsync('shutdown')

	executeStepAction: (step, { force, initial }) =>
		Promise.try =>
			if _.includes(@deviceConfig.validActions, step.action)
				@deviceConfig.executeStepAction(step, { initial })
			else if _.includes(@applications.validActions, step.action)
				@applications.executeStepAction(step, { force })
			else
				switch step.action
					when 'reboot'
						@reboot(force)
					when 'shutdown'
						@shutdown(force)
					when 'noop'
						Promise.resolve()
					else
						throw new Error("Invalid action #{step.action}")

	applyStepAsync: (step, { force, initial, intermediate }, updateContext) =>
		if @shuttingDown
			return
		updateContext.stepsInProgress.push(step)
		setImmediate =>
			@executeStepAction(step, { force, initial })
			.finally =>
				@usingInferStepsLock =>
					_.pullAllWith(updateContext.stepsInProgress, [ step ], _.isEqual)
			.catch (err) =>
				@emitAsync('step-error', err, step)
				throw err
			.then (stepResult) =>
				@emitAsync('step-completed', null, step, stepResult)
				@continueApplyTarget({ force, initial, intermediate }, updateContext)

	applyError: (err, force, { initial, intermediate }) =>
		if !intermediate
			@applyInProgress = false
			@failedUpdates += 1
			@reportCurrentState(update_failed: true)
			if @scheduledApply?
				console.log('Updating failed, but there is already another update scheduled immediately: ', err)
			else
				delay = Math.min((2 ** @failedUpdates) * 500, 30000)
				# If there was an error then schedule another attempt briefly in the future.
				console.log('Scheduling another update attempt due to failure: ', delay, err)
				@triggerApplyTarget({ force, delay, initial })
		@emitAsync('apply-target-state-error', err)
		@emitAsync('apply-target-state-end', err)
		throw err

	applyTarget: ({ force = false, initial = false, intermediate = false } = {}, updateContext) =>
		if !updateContext?
			updateContext = {
				stepsInProgress = []
				applyContinueScheduled = false
			}
		Promise.try =>
			if !intermediate
				@applyBlocker
		.then =>
			console.log('Applying target state')
			@usingInferStepsLock =>
				Promise.join(
					@getCurrentForComparison()
					@getTarget({ initial, intermediate })
					(currentState, targetState) =>
						@deviceConfig.getRequiredSteps(currentState, targetState, updateContext.stepsInProgress)
						.then (deviceConfigSteps) =>
							if !_.isEmpty(deviceConfigSteps)
								return deviceConfigSteps
							else
								@applications.getRequiredSteps(currentState, targetState, updateContext.stepsInProgress, intermediate)
				)
		.then (steps) =>
			if _.isEmpty(steps) and _.isEmpty(updateContext.stepsInProgress)
				if !intermediate
					console.log('Finished applying target state')
					@applyInProgress = false
					@applications.timeSpentFetching = 0
					@failedUpdates = 0
					@lastSuccessfulUpdate = Date.now()
					@reportCurrentState(update_failed: false, update_pending: false, update_downloaded: false)
					@emitAsync('apply-target-state-end', null)
				return
			if !intermediate
				@reportCurrentState(update_pending: true)
			Promise.map steps, (step) =>
				@applyStepAsync(step, { force, initial, intermediate }, updateContext)
		.catch (err) =>
			@applyError(err, force, { initial, intermediate })

	continueApplyTarget: ({ force = false, initial = false, intermediate = false } = {}, updateContext) =>
		Promise.try =>
			if !intermediate
				@applyBlocker
		.then =>
			if updateContext.applyContinueScheduled
				return
			updateContext.applyContinueScheduled = true
			Promise.delay(1000)
			.then =>
				updateContext.applyContinueScheduled = false
				@applyTarget({ force, initial }, updateContext)

	pauseNextApply: =>
		@applyBlocker = new Promise (resolve) =>
			@applyUnblocker = resolve

	resumeNextApply: =>
		@applyUnblocker?()

	triggerApplyTarget: ({ force = false, delay = 0, initial = false } = {}) =>
		if @applyInProgress
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
			@applyTarget({ force, initial })
			.finally =>
				@triggerApplyTarget(@scheduledApply)
				@scheduledApply = null
		return

	applyIntermediateTarget: (intermediateTarget, { force = false, skipLock = true } = {}) =>
		@intermediateTarget = intermediateTarget
		@applyTarget({ intermediate: true, force })
		.then =>
			@intermediateTarget = null
