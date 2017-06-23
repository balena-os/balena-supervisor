Promise = require 'bluebird'
constants = require './constants'
fs = Promise.promisifyAll(require('fs'))
containerConfig = require './lib/container-config'
Lock = require('rwlock')
module.exports = ({ db, config }) ->

	deviceState = new EventEmitter()
	deviceState.on 'error', (err) ->
		console.error("Error in deviceState: ", err, err.stack)
	deviceState._target = {}
	deviceState._currentVolatile = {}

	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	_readLock = Promise.promisify(_lock.async.writeLock)
	readLockTarget = _readLock('target').disposer (release) ->
		release()
	writeLockTarget = _writeLock('target').disposer (release) ->
		release()

	deviceState.writeTarget = ->
		Promise.using writeLockTarget(), ->


	deviceState.getTarget = ->
		return deviceState.target

	deviceState.getCurrent = ->
		currentState = {}
		Promise.join(
			config.get('name')
			deviceConfig.get('values')
			application.getAll()
			proxyvisor.getCurrentStates()
			(name, apps, dependent) ->
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

	deviceState.report = (newState) ->
		_.merge(deviceState._currentVolatile, newState)
		setImmediate -> deviceState.emit('current-state-change')

	deviceState.loadTargetFromFile = (appsPath) ->
		appsPath ?= constants.appsJsonPath
		Promise.join(
			config.getMany([ 'uuid', 'listenPort', 'name', 'apiSecret', 'version', 'deviceType', 'deviceApiKey' ])
			device.getOSVersion()
			([ uuid, listenPort, name, apiSecret, version, deviceType, deviceApiKey ], osVersion) ->
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
						deviceConfig.set({ targetValues: devConfig })
		)
		.catch (err) ->
			mixpanel.track('Loading preloaded apps failed', { error: err })

	return deviceState
