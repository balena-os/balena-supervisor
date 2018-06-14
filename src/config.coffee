Promise = require 'bluebird'
_ = require 'lodash'
Lock = require 'rwlock'
deviceRegister = require 'resin-register-device'
fs = Promise.promisifyAll(require('fs'))
EventEmitter = require 'events'
path = require 'path'
{ writeAndSyncFile, writeFileAtomic } = require './lib/fs-utils'
osRelease = require './lib/os-release'
supervisorVersion = require './lib/supervisor-version'
constants = require './lib/constants'

module.exports = class Config extends EventEmitter
	constructor: ({ @db, @configPath }) ->
		@funcs =
			version: ->
				Promise.resolve(supervisorVersion)
			currentApiKey: =>
				@getMany([ 'apiKey', 'deviceApiKey' ])
				.then ({ apiKey, deviceApiKey }) ->
					return deviceApiKey ? apiKey
			offlineMode: =>
				@getMany([ 'resinApiEndpoint', 'supervisorOfflineMode' ])
				.then ({ resinApiEndpoint, supervisorOfflineMode }) ->
					return Boolean(supervisorOfflineMode) or !Boolean(resinApiEndpoint)
			pubnub: =>
				@getMany([ 'pubnubSubscribeKey', 'pubnubPublishKey' ])
				.then ({ pubnubSubscribeKey, pubnubPublishKey }) ->
					pubnub = {
						subscribe_key: pubnubSubscribeKey
						publish_key: pubnubPublishKey
						ssl: true
					}
					return pubnub
			resinApiEndpoint: =>
				# Fall back to checking if an API endpoint was passed via env vars if there's none in config.json (legacy)
				@get('apiEndpoint')
				.then (apiEndpoint) ->
					return apiEndpoint ? constants.apiEndpointFromEnv

			provisioned: =>
				@getMany([ 'uuid', 'resinApiEndpoint', 'registered_at', 'deviceId' ])
				.then (requiredValues) ->
					return _.every(_.values(requiredValues), Boolean)

			osVersion: ->
				osRelease.getOSVersion(constants.hostOSVersionPath)

			osVariant: ->
				osRelease.getOSVariant(constants.hostOSVersionPath)

			provisioningOptions: =>
				@getMany([
					'uuid'
					'userId'
					'applicationId'
					'apiKey'
					'deviceApiKey'
					'deviceType'
					'resinApiEndpoint'
					'apiTimeout'
					'registered_at'
					'deviceId'
				]).then (conf) ->
					return {
						uuid: conf.uuid
						applicationId: conf.applicationId
						userId: conf.userId
						deviceType: conf.deviceType
						provisioningApiKey: conf.apiKey
						deviceApiKey: conf.deviceApiKey
						apiEndpoint: conf.resinApiEndpoint
						apiTimeout: conf.apiTimeout
						registered_at: conf.registered_at
						deviceId: conf.deviceId
					}

			mixpanelHost: =>
				@get('resinApiEndpoint')
				.then (apiEndpoint) ->
					return apiEndpoint + '/mixpanel'

			extendedEnvOptions: =>
				@getMany([ 'uuid', 'listenPort', 'name', 'apiSecret', 'deviceApiKey', 'version', 'deviceType', 'osVersion' ])

			fetchOptions: =>
				@getMany([
					'uuid'
					'currentApiKey'
					'resinApiEndpoint'
					'deltaEndpoint'
					'delta'
					'deltaRequestTimeout'
					'deltaApplyTimeout'
					'deltaRetryCount'
					'deltaRetryInterval'
					'deltaVersion'
				])

		@schema = {
			apiEndpoint: { source: 'config.json' }
			apiTimeout: { source: 'config.json', default: 15 * 60 * 1000 }
			listenPort: { source: 'config.json', default: 48484 }
			deltaEndpoint: { source: 'config.json', default: 'https://delta.resin.io' }
			uuid: { source: 'config.json', mutable: true }
			apiKey: { source: 'config.json', mutable: true, removeIfNull: true }
			deviceApiKey: { source: 'config.json', mutable: true }
			deviceType: { source: 'config.json', default: 'raspberry-pi' }
			username: { source: 'config.json' }
			userId: { source: 'config.json' }
			deviceId: { source: 'config.json', mutable: true }
			registered_at: { source: 'config.json', mutable: true }
			applicationId: { source: 'config.json' }
			appUpdatePollInterval: { source: 'config.json', mutable: true, default: 60000 }
			pubnubSubscribeKey: { source: 'config.json', default: constants.defaultPubnubSubscribeKey }
			pubnubPublishKey: { source: 'config.json', default: constants.defaultPubnubPublishKey }
			mixpanelToken: { source: 'config.json', default: constants.defaultMixpanelToken }
			bootstrapRetryDelay: { source: 'config.json', default: 30000 }
			supervisorOfflineMode: { source: 'config.json', default: false }
			hostname: { source: 'config.json', mutable: true }

			version: { source: 'func' }
			currentApiKey: { source: 'func' }
			offlineMode: { source: 'func' }
			pubnub: { source: 'func' }
			resinApiEndpoint: { source: 'func' }
			provisioned: { source: 'func' }
			osVersion: { source: 'func' }
			osVariant: { source: 'func' }
			provisioningOptions: { source: 'func' }
			mixpanelHost: { source: 'func' }
			extendedEnvOptions: { source: 'func' }
			fetchOptions: { source: 'func' }

			# NOTE: all 'db' values are stored and loaded as *strings*
			apiSecret: { source: 'db', mutable: true }
			logsChannelSecret: { source: 'db', mutable: true }
			name: { source: 'db', mutable: true }
			initialConfigReported: { source: 'db', mutable: true, default: 'false' }
			initialConfigSaved: { source: 'db', mutable: true, default: 'false' }
			containersNormalised: { source: 'db', mutable: true, default: 'false' }
			localMode: { source: 'db', mutable: true, default: 'false' }
			loggingEnabled: { source: 'db', mutable: true, default: 'true' }
			connectivityCheckEnabled: { source: 'db', mutable: true, default: 'true' }
			delta: { source: 'db', mutable: true, default: 'false' }
			deltaRequestTimeout: { source: 'db', mutable: true, default: '30000' }
			deltaApplyTimeout: { source: 'db', mutable: true, default: '' }
			deltaRetryCount: { source: 'db', mutable: true, default: '30' }
			deltaRetryInterval: { source: 'db', mutable: true, default: '10000' }
			deltaVersion: { source: 'db', mutable: true, default: '2' }
			lockOverride: { source: 'db', mutable: true, default: 'false' }
			legacyAppsPresent: { source: 'db', mutable: true, default: 'false' }
			nativeLogger: { source: 'db', mutable: true, default: 'true' }
			# A JSON value, which is either null, or { app: number, commit: string }
			pinDevice: { source: 'db', mutable: true, default: 'null' }
		}

		@configJsonCache = {}

		_lock = new Lock()
		_writeLock = Promise.promisify(_lock.async.writeLock)
		@writeLockConfigJson = ->
			_writeLock('config.json')
			.disposer (release) ->
				release()

		_readLock = Promise.promisify(_lock.async.readLock)
		@readLockConfigJson = ->
			_readLock('config.json')
			.disposer (release) ->
				release()

	writeConfigJson: =>
		atomicWritePossible = true
		@configJsonPathOnHost()
		.catch (err) ->
			console.error(err.message)
			atomicWritePossible = false
			return constants.configJsonNonAtomicPath
		.then (configPath) =>
			if atomicWritePossible
				writeFileAtomic(configPath, JSON.stringify(@configJsonCache))
			else
				writeAndSyncFile(configPath, JSON.stringify(@configJsonCache))


	configJsonSet: (keyVals) =>
		changed = false
		Promise.using @writeLockConfigJson(), =>
			Promise.mapSeries _.keys(keyVals), (key) =>
				value = keyVals[key]
				if @configJsonCache[key] != value
					@configJsonCache[key] = value
					if !value? and @schema[key].removeIfNull
						delete @configJsonCache[key]
					changed = true
			.then =>
				if changed
					@writeConfigJson()

	configJsonRemove: (key) =>
		changed = false
		Promise.using @writeLockConfigJson(), =>
			if @configJsonCache[key]?
				delete @configJsonCache[key]
				changed = true
			if changed
				@writeConfigJson()

	configJsonPathOnHost: =>
		Promise.try =>
			if @configPath?
				return @configPath
			if constants.configJsonPathOnHost?
				return constants.configJsonPathOnHost
			osRelease.getOSVersion(constants.hostOSVersionPath)
			.then (osVersion) ->
				if /^Resin OS 2./.test(osVersion)
					return path.join(constants.bootMountPointFromEnv, 'config.json')
				else if /^Resin OS 1./.test(osVersion)
					# In Resin OS 1.12, $BOOT_MOUNTPOINT was added and it coincides with config.json's path
					if constants.bootMountPointFromEnv
						return path.join(constants.bootMountPointFromEnv, 'config.json')
					# Older 1.X versions have config.json here
					return '/mnt/conf/config.json'
				else
					# In non-resinOS hosts (or older than 1.0.0), if CONFIG_JSON_PATH wasn't passed then we can't do atomic changes
					# (only access to config.json we have is in /boot, which is assumed to be a file bind mount where rename is impossible)
					throw new Error('Could not determine config.json path on host, atomic write will not be possible')
		.then (pathOnHost) ->
			return path.join(constants.rootMountPoint, pathOnHost)

	configJsonPath: =>
		@configJsonPathOnHost()
		.catch (err) ->
			console.error(err.message)
			return constants.configJsonNonAtomicPath

	readConfigJson: =>
		@configJsonPath()
		.then (configPath) ->
			fs.readFileAsync(configPath)
		.then(JSON.parse)

	newUniqueKey: ->
		deviceRegister.generateUniqueKey()

	generateRequiredFields: =>
		@getMany([ 'uuid', 'deviceApiKey', 'apiSecret', 'logsChannelSecret', 'offlineMode' ])
		.then ({ uuid, deviceApiKey, apiSecret, logsChannelSecret, offlineMode }) =>
			# These fields need to be set regardless
			if !uuid? or !apiSecret?
				uuid ?= @newUniqueKey()
				apiSecret ?= @newUniqueKey()
			@set({ uuid, apiSecret })
			.then =>
				# These fields only need set when we're not in offlineMode
				return if offlineMode
				if !deviceApiKey? or !logsChannelSecret?
					deviceApiKey ?= @newUniqueKey()
					logsChannelSecret ?= @newUniqueKey()
					@set({ deviceApiKey, logsChannelSecret })

	regenerateRegistrationFields: =>
		uuid = deviceRegister.generateUniqueKey()
		deviceApiKey = deviceRegister.generateUniqueKey()
		@set({ uuid, deviceApiKey })

	get: (key, trx) =>
		db = trx ? @db.models
		# Get value for "key" from config.json or db
		Promise.try =>
			switch @schema[key]?.source
				when undefined
					throw new Error("Unknown config value #{key}")
				when 'func'
					@funcs[key]()
					.catch (err) ->
						console.error("Error getting config value for #{key}", err, err.stack)
						return null
				when 'config.json'
					Promise.using @readLockConfigJson(), =>
						return @configJsonCache[key]
				when 'db'
					db('config').select('value').where({ key })
					.then ([ conf ]) ->
						return conf?.value
		.then (value) =>
			if !value? and @schema[key]?.default?
				return @schema[key].default
			return value

	getMany: (keys, trx) =>
		# Get the values for several keys in an array
		Promise.map(keys, (key) => @get(key, trx))
		.then (values) ->
			out = {}
			for key, i in keys
				out[key] = values[i]
			return out

	# Sets config values as atomically as possible
	# Is atomic if all values have the same source, otherwise it's atomic for each source
	set: (keyValues, trx) =>
		Promise.try =>
			# Write value to config.json or DB
			{ configJsonVals, dbVals } =  _.reduce(keyValues, (acc, val, key) =>
				if !@schema[key]?.mutable
					throw new Error("Attempt to change immutable config value #{key}")
				switch @schema[key]?.source
					when 'config.json'
						acc.configJsonVals[key] = val
					when 'db'
						acc.dbVals[key] = val
				return acc
			, { configJsonVals: {}, dbVals: {} })

			setValuesInTransaction = (tx) =>
				dbKeys = _.keys(dbVals)
				@getMany(dbKeys, tx)
				.then (oldValues) =>
					Promise.map dbKeys, (key) =>
						value = dbVals[key]
						if oldValues[key] != value
							@db.upsertModel('config', { key, value }, { key }, tx)
				.then =>
					if !_.isEmpty(configJsonVals)
						@configJsonSet(configJsonVals)
			if trx?
				setValuesInTransaction(trx)
			else
				@db.transaction (tx) ->
					setValuesInTransaction(tx)
		.then =>
			setImmediate =>
				@emit('change', keyValues)

	# Clear a value from config.json or DB
	# (will be used to clear the provisioning key)
	# only mutable fields!
	remove: (key) =>
		Promise.try =>
			if !@schema[key]?.mutable
				throw new Error("Attempt to delete immutable config value #{key}")
			switch @schema[key]?.source
				when 'config.json'
					@configJsonRemove(key)
				when 'db'
					@db.models('config').del().where({ key })

	init: =>
		# Read config.json and cache its values
		# get or generate apiSecret, logsChannelSecret, uuid
		@readConfigJson()
		.then (configJson) =>
			_.assign(@configJsonCache, configJson)
		.then =>
			# get or generate uuid, apiSecret, logsChannelSecret
			@generateRequiredFields()
