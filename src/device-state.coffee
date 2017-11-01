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
migration = require './lib/migration'

DeviceConfig = require './device-config'
Logger = require './logger'
ApplicationManager = require './application-manager'

validateLocalState = (state) ->
	if state.name? and !validation.isValidShortText(state.name)
		throw new Error('Invalid device name')
	if state.apps? and !validation.isValidAppsObject(state.apps)
		throw new Error('Invalid apps')
	if state.config? and !validation.isValidEnv(state.config)
		throw new Error('Invalid device configuration')

validateDependentState = (state) ->
	if state.apps? and !validation.isValidDependentAppsObject(state.apps)
		throw new Error('Invalid dependent apps')
	if state.devices? and !validation.isValidDependentDevicesObject(state.devices)
		throw new Error('Invalid dependent devices')

validateState = Promise.method (state) ->
	throw new Error('State must be an object') if !_.isObject(state)
	validateLocalState(state.local) if state.local?
	validateDependentState(state.dependent) if state.dependent?

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
		@applications = new ApplicationManager({ @config, @logger, @db, @eventTracker })
		@on 'error', (err) ->
			console.error('Error in deviceState: ', err, err.stack)
		@_currentVolatile = {}
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@_readLock = Promise.promisify(_lock.async.writeLock)
		@lastSuccessfulUpdate = null
		@failedUpdates = 0
		@stepsInProgress = []
		@applyInProgress = false
		@scheduledApply = null
		@applyContinueScheduled = false
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

	normaliseLegacy: ({ apps, dependentApps, dependentDevices }) =>
		legacyTarget = { local: { apps: [], config: {} }, dependent: { apps: [], devices: [] } }

		tryParseObj = (j) ->
			try
				JSON.parse(j)
			catch
				{}
		tryParseArray = (j) ->
			try
				JSON.parse(j)
			catch
				[]

		dependentDevices = tryParseArray(dependentDevices)
		# Old containers have to be killed as we can't update their labels
		@deviceConfig.getCurrent()
		.then (deviceConf) =>
			legacyTarget.local.config = deviceConf
			console.log('Killing legacy containers')
			@applications.services.killAllLegacy()
		.then =>
			@config.get('name')
		.then (name) ->
			legacyTarget.local.name = name ? ''
		.then =>
			console.log('Migrating apps')
			Promise.map tryParseArray(apps), (app) =>
				@applications.images.normalise(app.imageId)
				.then (image) =>
					appAsState = {
						image: image
						commit: app.commit
						name: app.name ? ''
						environment: tryParseObj(app.env)
						config: tryParseObj(app.config)
					}
					appAsState.environment = _.omitBy appAsState.environment, (v, k) ->
						_.startsWith(k, 'RESIN_')
					appId = app.appId
					# Only for apps for which we have the image locally,
					# we translate that app to the target state so that we run
					# a (mostly) compatible container until a new target state is fetched.
					# This is also necessary to avoid cleaning up the image, which may
					# be needed for cache/delta in the next update.
					multicontainerApp = migration.singleToMulticontainerApp(appAsState, appId)
					@applications.images.inpectByName(appAsState.image)
					.then =>
						@applications.images.markAsSupervised(@applications.imageForService(multicontainerApp.services['1']))
					.then =>
						if !_.isEmpty(appAsState.config)
							devConf = @deviceConfig.filterConfigKeys(appAsState.config)
							_.assign(legacyTarget.local.config, devConf) if !_.isEmpty(devConf)
						legacyTarget.local.apps.push(multicontainerApp)
					.then =>
						@applications.volumes.createFromLegacy(appId)
				.catch (err) ->
					console.error("Ignoring legacy app #{app.imageId} due to #{err}")
		.then =>
			console.log('Migrating dependent apps and devices')
			Promise.map tryParseArray(dependentApps), (app) =>
				appAsState = {
					appId: app.appId
					parentApp: app.parentAppId
					image: app.imageId
					releaseId: null
					commit: app.commit
					name: app.name
					config: tryParseObj(app.config)
					environment: tryParseObj(app.environment)
				}
				@applications.images.inspectByName(app.imageId)
				.then =>
					@applications.images.markAsSupervised(@applications.proxyvisor.imageForDependentApp(appAsState))
				.then =>
					appForDB = _.clone(appAsState)
					appForDB.config = JSON.stringify(appAsState.config)
					appForDB.environment = JSON.stringify(appAsState.environment)
					@db.models('dependentApp').insert(appForDB)
				.then =>
					legacyTarget.dependent.apps.push(appAsState)
					devicesForThisApp = _.filter(dependentDevices ? [], (d) -> d.appId == appAsState.appId)
					if !_.isEmpty(devicesForThisApp)
						devices = _.map devicesForThisApp, (d) ->
							d.markedForDeletion ?= false
							d.localId ?= null
							d.is_managed_by ?= null
							d.lock_expiry_date ?= null
							return d
						devicesForState = _.map devicesForThisApp, (d) ->
							dev = {
								uuid: d.uuid
								name: d.name
								apps: {}
							}
							dev.apps[d.appId] = {
								config: tryParseObj(d.targetConfig)
								environment: tryParseObj(d.targetEnvironment)
							}
						legacyTarget.dependent.devices = legacyTarget.dependent.devices.concat(devicesForState)
						@db.models('dependentDevice').insert(devices)
				.catch (err) ->
					console.error("Ignoring legacy dependent app #{app.imageId} due to #{err}")
		.then =>
			@setTarget(legacyTarget)
		.then =>
			@config.set({ initialConfigSaved: 'true' })

	init: ->
		@config.getMany([
			'logsChannelSecret', 'pubnub', 'offlineMode', 'loggingEnabled', 'initialConfigSaved',
			'listenPort', 'apiSecret', 'osVersion', 'osVariant', 'version', 'provisioned',
			'resinApiEndpoint', 'connectivityCheckEnabled'
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
					@logger.enable(changedConfig.loggingEnabled) if changedConfig.loggingEnabled?
					@reportCurrentState(api_secret: changedConfig.apiSecret) if changedConfig.apiSecret?
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
				@loadTargetFromFile() if !conf.provisioned
			.then =>
				@triggerApplyTarget()

	initNetworkChecks: ({ resinApiEndpoint, connectivityCheckEnabled }) =>
		network.startConnectivityCheck(resinApiEndpoint, connectivityCheckEnabled)
		@config.on 'change', (changedConfig) ->
			network.enableConnectivityCheck(changedConfig.connectivityCheckEnabled) if changedConfig.connectivityCheckEnabled?
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

	readLockTarget: =>
		@_readLock('target').disposer (release) ->
			release()
	writeLockTarget: =>
		@_writeLock('target').disposer (release) ->
			release()
	inferStepsLock: =>
		@_writeLock('inferSteps').disposer (release) ->
			release()

	setTarget: (target) ->
		validateState(target)
		.then =>
			Promise.using @writeLockTarget(), =>
				# Apps, deviceConfig, dependent
				@db.transaction (trx) =>
					Promise.try =>
						@config.set({ name: target.local.name }, trx) if target.local?.name?
					.then =>
						@deviceConfig.setTarget(target.local.config, trx) if target.local?.config?
					.then =>
						@applications.setTarget(target.local?.apps, target.dependent, trx)

	getTarget: ->
		Promise.using @readLockTarget(), =>
			Promise.props({
				local: Promise.props({
					name: @config.get('name')
					config: @deviceConfig.getTarget()
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
			theState.local.is_on__commit = appsStatus.commit if appsStatus.commit
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

	loadTargetFromFile: (appsPath) ->
		appsPath ?= constants.appsJsonPath
		fs.readFileAsync(appsPath, 'utf8')
		.then(JSON.parse)
		.then (stateFromFile) =>
			if !_.isEmpty(stateFromFile)
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
						@applications.images.markAsSupervised(img)
				.then =>
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

	executeStepAction: (step, { force, targetState }) =>
		Promise.try =>
			if _.includes(@deviceConfig.validActions, step.action)
				@deviceConfig.executeStepAction(step)
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

	applyStepAsync: (step, { force, targetState }) =>
		return if @shuttingDown
		@stepsInProgress.push(step)
		setImmediate =>
			@executeStepAction(step, { force, targetState })
			.finally =>
				Promise.using @inferStepsLock(), =>
					_.pullAllWith(@stepsInProgress, [ step ], _.isEqual)
			.then (stepResult) =>
				@emitAsync('step-completed', null, step, stepResult)
				@continueApplyTarget({ force })
			.catch (err) =>
				@emitAsync('step-error', err, step)
				@applyError(err, force)

	applyError: (err, force) =>
		@_applyingSteps = false
		@applyInProgress = false
		@failedUpdates += 1
		@reportCurrentState(update_failed: true)
		if @scheduledApply?
			console.log('Updating failed, but there is already another update scheduled immediately: ', err)
		else
			delay = Math.min((2 ** @failedUpdates) * 500, 30000)
			# If there was an error then schedule another attempt briefly in the future.
			console.log('Scheduling another update attempt due to failure: ', delay, err)
			@triggerApplyTarget({ force, delay })
		@emitAsync('apply-target-state-error', err)
		@emitAsync('apply-target-state-end', err)

	applyTarget: ({ force = false } = {}) =>
		console.log('Applying target state')
		Promise.using @inferStepsLock(), =>
			Promise.join(
				@getCurrentForComparison()
				@getTarget()
				(currentState, targetState) =>
					@deviceConfig.getRequiredSteps(currentState, targetState, @stepsInProgress)
					.then (deviceConfigSteps) =>
						if !_.isEmpty(deviceConfigSteps)
							return deviceConfigSteps
						else
							@applications.getRequiredSteps(currentState, targetState, @stepsInProgress)
			)
			.then (steps) =>
				if _.isEmpty(steps) and _.isEmpty(@stepsInProgress)
					console.log('Finished applying target state')
					@applyInProgress = false
					@failedUpdates = 0
					@lastSuccessfulUpdate = Date.now()
					@reportCurrentState(update_failed: false, update_pending: false, update_downloaded: false)
					@emitAsync('apply-target-state-end', null)
					return
				@reportCurrentState(update_pending: true)
				Promise.map steps, (step) =>
					@applyStepAsync(step, { force })
		.catch (err) =>
			@applyError(err, force)

	continueApplyTarget: ({ force = false } = {}) =>
		return if @applyContinueScheduled
		@applyContinueScheduled = true
		setTimeout( =>
			@applyContinueScheduled = false
			@applyTarget({ force })
		, 1000)
		return

	triggerApplyTarget: ({ force = false, delay = 0 } = {}) =>
		if @applyInProgress
			if !@scheduledApply?
				@scheduledApply = { force, delay }
				@once 'apply-target-state-end', =>
					@triggerApplyTarget(@scheduledApply)
					@scheduledApply = null
			else
				# If a delay has been set it's because we need to hold off before applying again,
				# so we need to respect the maximum delay that has been passed
				@scheduledApply.delay = Math.max(delay, @scheduledApply.delay)
				@scheduledApply.force or= force
			return
		@applyInProgress = true
		setTimeout( =>
			@applyTarget({ force })
		, delay)
		return
