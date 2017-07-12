Promise = require 'bluebird'
_ = require 'lodash'
Lock = require 'rwlock'
EventEmitter = require 'events'
fs = Promise.promisifyAll(require('fs'))

containerConfig = require './lib/container-config'
constants = require './lib/constants'
validation = require './lib/validation'
{ dbToState, stateToDB, keyByAndOmit } = require './lib/app-conversions'

DeviceConfig = require './device-config'
Logger = require './logger'
#Application = require './application'
#proxyvisor = require './proxyvisor'

validateLocalState = (state) ->
	if state.name? and !validation.isValidShortText(state.name)
		throw new Error('Invalid device name')
	if state.apps? and !validation.isValidAppsObject(state.apps)
		throw new Error('Invalid apps')
	if state.config? and !validation.isValidEnv(state.config)
		throw new Error('Invalid device configuration')

validateDependentState = (state) ->
	if state.apps? and !validation.isValidAppsObject(state.apps)
		throw new Error('Invalid dependent apps')
	if state.devices? and !validation.isValidDependentDevicesObject(state.devices)
		throw new Error('Invalid dependent devices')

validateState = Promise.method (state) ->
	validateLocalState(state.local) if state.local?
	validateDependentState(state.dependent) if state.dependent?

UPDATE_IDLE = 0
UPDATE_UPDATING = 1
UPDATE_REQUIRED = 2
UPDATE_SCHEDULED = 3

module.exports = class DeviceState extends EventEmitter
	constructor: ({ @db, @config, @eventTracker }) ->
		@logger = new Logger({ @eventTracker })
		@deviceConfig = new DeviceConfig({ @db, @config, @logger })
		#@application = new Application({ @config, @logger })
		#@application = new Application({ @db, @config, deviceState: this })
		@on 'error', (err) ->
			console.error('Error in deviceState: ', err, err.stack)
		@_currentVolatile = {}
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@_readLock = Promise.promisify(_lock.async.writeLock)
		@lastSuccessfulUpdate = null
		@failedUpdates = 0

	init: ->
		@config.on 'change', (changedConfig) =>
			@logger.enable(changedConfig.loggingEnabled) if changedConfig.loggingEnabled?
		@config.getMany([ 'logsChannelSecret', 'pubnub', 'offlineMode', 'loggingEnabled' ])
		.then (conf) =>
			@logger.init({
				pubnub: conf.pubnub
				channel: "device-#{conf.logsChannelSecret}-logs"
				offlineMode: !conf.offlineMode
				enable: conf.loggingEnabled
			})

	emitAsync: (ev, args) =>
		setImmediate => @emit(ev, args)

	readLockTarget: =>
		@_readLock('target').disposer (release) ->
			release()
	writeLockTarget: =>
		@_writeLock('target').disposer (release) ->
			release()
	writeLockApply: =>
		@_writeLock('apply').disposer (release) ->
			release()

	setTarget: (target) ->
		validateState(target)
		.then =>
			Promise.using @writeLockTarget(), =>
				# Apps, deviceConfig, dependent
				Promise.try =>
					@config.set({ name: target.local.name }) if target.local?.name?
				.then =>
					@deviceConfig.setTarget(target.local.config) if target.local?.config?
				.then =>
					if target.local?.apps?
						appsForDB = _.map target.local.apps, (app, appId) ->
							stateToDB(app, appId)
						Promise.map appsForDB, (app) =>
							@db.upsertModel('app', app, { appId: app.appId })
				.then ->
				# TO DO: set dependent apps and devices from target.dependent


	# BIG TODO: correctly include dependent apps/devices
	getTarget: ->
		Promise.using @readLockTarget(), =>
			Promise.props({
				local: Promise.props({
					name: @config.get('name')
					config: @deviceConfig.getTarget()
					apps: @db.models('app').select().map(dbToState).then (apps) ->
						keyByAndOmit(apps, 'appId')
				})
				dependent: Promise.props({
					apps: @db.models('dependentApp').select().map(dbToState).then (apps) ->
						keyByAndOmit(apps, 'appId')
					devices: {} #db('dependentDevice').select().map (device) ->

				})
			})

	getCurrent: ->
		Promise.join(
			@config.get('name')
			@deviceConfig.getCurrent()
			@application.listCurrent()
			@proxyvisor.getCurrentStates()
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

	reportCurrent: (newState = {}) ->
		_.merge(@_currentVolatile, newState)
		@emitAsync('current-state-change')

	loadTargetFromFile: (appsPath) ->
		appsPath ?= constants.appsJsonPath
		@config.getMany([
			'uuid'
			'listenPort'
			'name'
			'apiSecret'
			'version'
			'deviceType'
			'deviceApiKey'
			'osVersion'
		])
		.then (conf) =>
			devConfig = {}
			@db.models('app').truncate()
			.then ->
				fs.readFileAsync(appsPath, 'utf8')
			.then(JSON.parse)
			.map (app) ->
				opts = _.clone(conf)
				opts.appId = app.appId
				opts.appName = app.name
				opts.commit = app.commit
				containerConfig.extendEnvVars(app.env, opts)
				.then (extendedEnv) ->
					app.env = JSON.stringify(extendedEnv)
					_.merge(devConfig, app.config)
					app.config = JSON.stringify(app.config)
					return dbToState(app)
			.then (apps) =>
				@setTarget({
					local:
						config: devConfig
						apps: keyByAndOmit(apps, 'appId')
				})
		.catch (err) =>
			@eventTracker.track('Loading preloaded apps failed', { error: err })

	# Triggers an applyTarget call immediately (but asynchronously)
	triggerApplyTarget: (opts) ->
		setImmediate =>
			@applyTarget(opts)

	# Aligns the current state to the target state
	applyTarget: ({ force = false } = {}) =>
		Promise.using @writeLockApply(), =>
			Promise.join(
				@getCurrent()
				@getTarget()
				(current, target) =>
					return if _.isEqual(current, target)
					Promise.try =>
						@deviceConfig.applyTarget() if !_.isEqual(current.local.config, target.local.config)
					.then ->
						@application.applyTarget(target.local.apps, { force }) if !_.isEqual(current.local.apps, target.local.apps)
					.then ->
						@proxyvisor.applyTarget()
			)
			.then =>
				@config.get('localMode')
			.then (localMode) =>
				return if localMode
				@failedUpdates = 0
				@lastSuccessfulUpdate = Date.now()
				@reportCurrent(update_pending: false, update_downloaded: false, update_failed: false)
				# We cleanup here as we want a point when we have a consistent apps/images state, rather than potentially at a
				# point where we might clean up an image we still want.
				@emitAsync('apply-target-state-success')
				@application.cleanup()
			.catch (err) =>
				@failedUpdates++
				@reportCurrent(update_failed: true)
				@emitAsync('apply-target-state-error', err)
			.finally =>
				@reportCurrent(status: 'Idle')
