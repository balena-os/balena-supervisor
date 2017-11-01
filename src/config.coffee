Promise = require 'bluebird'
_ = require 'lodash'
Lock = require 'rwlock'
deviceRegister = require 'resin-register-device'
fs = Promise.promisifyAll(require('fs'))
EventEmitter = require 'events'

{ writeAndSyncFile, writeFileAtomic } = require './lib/fs-utils'
osRelease = require './lib/os-release'
supervisorVersion = require './lib/supervisor-version'
constants = require './lib/constants'

module.exports = class Config extends EventEmitter
	constructor: ({ @db, @configPath }) ->
		# These are values that come from env vars or hardcoded defaults and can be resolved synchronously
		# Defaults needed for both gosuper and node supervisor are declared in entry.sh
		@constants = constants

		@funcs =
			version: ->
				Promise.resolve(supervisorVersion)
			currentApiKey: =>
				@getMany([ 'apiKey', 'deviceApiKey' ])
				.then ({ apiKey, deviceApiKey }) ->
					return apiKey ? deviceApiKey
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
					return apiEndpoint ? @constants.apiEndpointFromEnv

			provisioned: =>
				@getMany([ 'uuid', 'resinApiEndpoint', 'registered_at', 'deviceId' ])
				.then (requiredValues) ->
					return _.every(_.values(requiredValues), Boolean)

			osVersion: =>
				osRelease.getOSVersion(@constants.hostOSVersionPath)

			osVariant: =>
				osRelease.getOSVariant(@constants.hostOSVersionPath)

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
			pubnubSubscribeKey: { source: 'config.json', default: @constants.defaultPubnubSubscribeKey }
			pubnubPublishKey: { source: 'config.json', default: @constants.defaultPubnubPublishKey }
			mixpanelToken: { source: 'config.json', default: @constants.defaultMixpanelToken }
			bootstrapRetryDelay: { source: 'config.json', default: 30000 }
			supervisorOfflineMode: { source: 'config.json', default: false }

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
			deltaRequestTimeout: { source: 'db', mutable: true, default: '' }
			deltaApplyTimeout: { source: 'db', mutable: true, default: '' }
			deltaRetryCount: { source: 'db', mutable: true, default: '' }
			deltaRetryInterval: { source: 'db', mutable: true, default: '' }
			lockOverride: { source: 'db', mutable: true, default: 'false' }
		}

		@configJsonCache = {}

		@_lock = new Lock()
		@_writeLock = Promise.promisify(@_lock.async.writeLock)
		@writeLockConfigJson = =>
			@_writeLock('config.json')
			.disposer (release) ->
				release()

		@_readLock = Promise.promisify(@_lock.async.readLock)
		@readLockConfigJson = =>
			@_readLock('config.json')
			.disposer (release) ->
				release()

	writeConfigJson: =>
		atomicWritePossible = true
		@configJsonPathOnHost()
		.catch (err) =>
			console.error(err.message)
			atomicWritePossible = false
			return @constants.configJsonNonAtomicPath
		.then (path) =>
			if atomicWritePossible
				writeFileAtomic(path, JSON.stringify(@configJsonCache))
			else
				writeAndSyncFile(path, JSON.stringify(@configJsonCache))


	configJsonSet: (keyVals) =>
		changed = false
		Promise.using @writeLockConfigJson(), =>
			Promise.mapSeries _.keys(keyVals), (key) =>
				value = keyVals[key]
				if @configJsonCache[key] != value
					@configJsonCache[key] = value
					delete @configJsonCache[key] if !value? and @schema[key].removeIfNull
					changed = true
			.then =>
				@writeConfigJson() if changed

	configJsonRemove: (key) =>
		changed = false
		Promise.using @writeLockConfigJson(), =>
			Promise.try =>
				if @configJsonCache[key]?
					delete @configJsonCache[key]
					changed = true
			.then =>
				@writeConfigJson() if changed

	configJsonPathOnHost: =>
		Promise.try =>
			return @configPath if @configPath?
			return @constants.configJsonPathOnHost if @constants.configJsonPathOnHost?
			osRelease.getOSVersion(@constants.hostOSVersionPath)
			.then (osVersion) =>
				if /^Resin OS 2./.test(osVersion)
					return "#{@constants.bootMountPointFromEnv}/config.json"
				else if /^Resin OS 1./.test(osVersion)
					# In Resin OS 1.12, $BOOT_MOUNTPOINT was added and it coincides with config.json's path
					return "#{@constants.bootMountPointFromEnv}/config.json" if @constants.bootMountPointFromEnv
					# Older 1.X versions have config.json here
					return '/mnt/conf/config.json'
				else
					# In non-resinOS hosts (or older than 1.0.0), if CONFIG_JSON_PATH wasn't passed then we can't do atomic changes
					# (only access to config.json we have is in /boot, which is assumed to be a file bind mount where rename is impossible)
					throw new Error('Could not determine config.json path on host, atomic write will not be possible')
		.then (path) =>
			return "#{@constants.rootMountPoint}#{path}"

	configJsonPath: =>
		@configJsonPathOnHost()
		.catch (err) =>
			console.error(err.message)
			return @constants.configJsonNonAtomicPath

	readConfigJson: =>
		@configJsonPath()
		.then (path) ->
			fs.readFileAsync(path)
			.then(JSON.parse)

	newUniqueKey: ->
		deviceRegister.generateUniqueKey()

	generateRequiredFields: =>
		@getMany([ 'uuid', 'deviceApiKey', 'apiSecret', 'logsChannelSecret' ])
		.then ({ uuid, deviceApiKey, apiSecret, logsChannelSecret }) =>
			if !uuid? or !deviceApiKey? or !apiSecret? or !logsChannelSecret?
				uuid ?= @newUniqueKey()
				deviceApiKey ?= @newUniqueKey()
				apiSecret ?= @newUniqueKey()
				logsChannelSecret ?= @newUniqueKey()
				@set({ uuid, deviceApiKey, apiSecret, logsChannelSecret })

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
		Promise.all(_.map(keys, (key) => @get(key, trx) ))
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
				throw new Error("Attempt to change immutable config value #{key}") if !@schema[key]?.mutable
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
					@configJsonSet(configJsonVals) if !_.isEmpty(configJsonVals)
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
			throw new Error("Attempt to delete immutable config value #{key}") if !@schema[key]?.mutable
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
