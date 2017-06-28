Promise = require 'bluebird'
constants = require './constants'
fs = Promise.promisifyAll(require('fs'))
containerConfig = require './lib/container-config'
Lock = require('rwlock')
_ = require 'lodash'
EventEmitter = require 'events'
mixpanel = require './mixpanel'
DeviceConfig = require './device-config'
validation = require './lib/validation'

module.exports = ({ db, config }) ->

	deviceConfig = new DeviceConfig({ db, config })

	deviceState = new EventEmitter()
	deviceState.on 'error', (err) ->
		console.error('Error in deviceState: ', err, err.stack)
	deviceState._target = {}
	deviceState._currentVolatile = {}

	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	_readLock = Promise.promisify(_lock.async.writeLock)
	readLockTarget = ->
		_readLock('target').disposer (release) ->
			release()
	writeLockTarget = ->
		_writeLock('target').disposer (release) ->
			release()

	keyByAndOmit = (collection, key) ->
		_.mapValues(_.keyBy(collection, key), (el) -> _.omit(el, key))

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
		validate LocalState(target.local) if target.local?
		validateDependentState(target.dependent) if target.dependent?

	deviceState.setTarget = (target) ->
		validateState(target)
		.then ->
			Promise.using writeLockTarget(), ->
				# Apps, deviceConfig, dependent
				Promise.try ->
					config.set({ name: target.local.name }) if target.local?.name?
				.then ->
					deviceConfig.setTarget(target.local.config) if target.local?.config?
				.then ->
					if target.local?.apps?
						console.log('To do: save apps')

	# BIG TODO: correctly include dependent apps/devices
	deviceState.getTarget = ->
		Promise.using readLockTarget(), ->
			Promise.props({
				local: Promise.props({
					name: config.get('name')
					config: deviceConfig.getTarget()
					apps: db('app').select().map (app) ->
						return {
							appId: app.appId
							image: app.imageId
							name: app.name
							commit: app.commit
							environment: JSON.parse(app.env)
							config: JSON.parse(app.config)
						}
					.then (apps) ->
						keyByAndOmit(apps, 'appId')
				})
				dependent: Promise.props({
					apps: db('dependentApp').select().map (app) ->
						return {
							appId: app.appId
							name: app.name
							parentApp: app.parentApp
							commit: app.commit
							image: app.imageId
							config: JSON.parse(app.config)
						}
					.then (apps) ->
						keyByAndOmit(apps, 'appId')
					devices: {} #db('dependentDevice').select().map (device) ->

				})
			})

	deviceState.getCurrent = ->
		currentState = {}
		Promise.join(
			config.get('name')
			deviceConfig.getCurrent()
			application.getAll()
			proxyvisor.getCurrentStates()
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

		# Get device name
		# Get config.txt and logs-to-display current values, build deviceConfig
		# Get docker containers, build apps object

	deviceState.reportCurrent = (newState = {}) ->
		_.merge(deviceState._currentVolatile, newState)
		setImmediate -> deviceState.emit('current-state-change')

	deviceState.loadTargetFromFile = (appsPath) ->
		appsPath ?= constants.appsJsonPath
		config.getMany([ 'uuid', 'listenPort', 'name', 'apiSecret', 'version', 'deviceType', 'deviceApiKey' , 'osVersion'])
		.spread (uuid, listenPort, name, apiSecret, version, deviceType, deviceApiKey , osVersion) ->
			Promise.using writeLockTarget(), ->
				devConfig = {}
				db('app').truncate()
				.then ->
					fs.readFileAsync(appsPath, 'utf8')
				.then(JSON.parse)
				.map (app) ->
					containerConfig.extendEnvVars(app.env, {
						uuid
						appId: app.appId
						appName: app.name
						commit: app.commit
						listenPort
						name
						apiSecret
						deviceApiKey
						version
						deviceType
						osVersion
					})
					.then (extendedEnv) ->
						app.env = JSON.stringify(extendedEnv)
						_.merge(devConfig, app.config)
						app.config = JSON.stringify(app.config)
						db('app').insert(app)
				.then ->
					deviceConfig.setTarget(devConfig)
		.catch (err) ->
			mixpanel.track('Loading preloaded apps failed', { error: err })

	deviceState.triggerAlignment = ->
		setImmediate(deviceState.align)

	# Aligns the current state to the target state
	deviceState.align = ->
		Promise.join(
			deviceState.getCurrent()
			deviceState.getTarget()
			(current, target) ->
				return if _.isEqual(current, target)
				Promise.try ->
					deviceConfig.applyTarget() if !_.isEqual(current.local.config, target.local.config)
				.then ->


		)
		.catch (err) ->


	return deviceState
