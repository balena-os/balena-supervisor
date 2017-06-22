Promise = require 'bluebird'
constants = require './constants'
fs = Promise.promisifyAll(require('fs'))
containerConfig = require './container-config'
Lock = require('rwlock')
module.exports = ({ db, config }) ->

	deviceState = { target: {} }

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
		# Get device name
		# Get config.txt and logs-to-display current values, build deviceConfig
		# Get docker containers, build apps object


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
