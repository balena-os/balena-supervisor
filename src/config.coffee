Promise = require 'bluebird'
Lock = require 'rwlock'
memoizee = require 'memoizee'
deviceRegister = require 'resin-register-device'
_ = require 'lodash'
fs = Promise.promisifyAll(require('fs'))
osRelease = require './lib/os-release'

memoizePromise = _.partial(memoizee, _, promise: 'then')

writeAndSyncFile = (path, data) ->
	fs.openAsync(path, 'w')
	.then (fd) ->
		fs.writeAsync(fd, data, 0, 'utf8')
		.then ->
			fs.fsyncAsync(fd)
		.then ->
			fs.closeAsync(fd)

module.exports = class Config
	constructor: ({ @db, @configPath }) ->
		# These are values that come from env vars or hardcoded defaults and can be resolved synchronously
		# Defaults needed for both gosuper and node supervisor are declared in entry.sh
		@constants = constants = require './constants'

		@funcs =
			version: ->
				require('./lib/supervisor-version')
			currentApiKey: =>
				@getMany([ 'apiKey', 'deviceApiKey' ])
				.spread (apiKey, deviceApiKey) ->
					return apiKey ? deviceApiKey
			offlineMode: =>
				@getMany([ 'resinApiEndpoint', 'supervisorOfflineMode' ])
				.spread (apiEndpoint, supervisorOfflineMode) ->
					return Boolean(supervisorOfflineMode) or !Boolean(apiEndpoint)
			pubnub: =>
				@getMany(['pubnubSubscribeKey', 'pubnubPublishKey' ])
				.spread (pubnubSubscribeKey, pubnubPublishKey) ->
					pubnub = {
						subscribe_key: pubnubSubscribeKey ? constants.defaultPubnubSubscribeKey
						publish_key: pubnubPublishKey ? constants.defaultPubnubPublishKey
						ssl: true
					}
					return pubnub
			resinApiEndpoint: =>
				# Fall back to checking if an API endpoint was passed via env vars if there's none in config.json (legacy)
				@get('apiEndpoint')
				.then (apiEndpoint) ->
					return apiEndpoint ? constants.apiEndpointFromEnv

			provisioned: =>
				@getMany([ 'uuid', 'apiEndpoint', 'registered_at', 'deviceId' ])
				.then (requiredValues) ->
					return _.every(requiredValues, Boolean)

			osVersion: ->
				osRelease.getOSVersion(constants.hostOSVersionPath)

		@schema = {
			apiEndpoint: { source: 'config.json' }
			apiTimeout: { source: 'config.json' }
			listenPort: { source: 'config.json' }
			deltaEndpoint: { source: 'config.json', default: 'https://delta.resin.io' }
			uuid: { source: 'config.json', mutable: true }
			apiKey: { source: 'config.json', mutable: true }
			deviceApiKey: { source: 'config.json', mutable: true }
			deviceType: { source: 'config.json' }
			username: { source: 'config.json' }
			userId: { source: 'config.json' }
			deviceId: { source: 'config.json', mutable: true }
			registered_at: { source: 'config.json', mutable: true }
			applicationId: { source: 'config.json' }
			appUpdatePollInterval: { source: 'config.json', mutable: true, default: 60000 }
			pubnubSubscribeKey: { source: 'config.json' }
			pubnubPublishKey: { source: 'config.json' }
			mixpanelToken: { source: 'config.json', default: constants.defaultMixpanelToken }
			bootstrapRetryDelay: { source: 'config.json', default: 30000 }

			version: { source: 'func' }
			currentApiKey: { source: 'func' }
			offlineMode: { source: 'func' }
			pubnub: { source: 'func' }
			resinApiEndpoint: { source: 'func' }
			provisioned: { source: 'func' }
			osVersion: { source: 'func' }

			apiSecret: { source: 'db', mutable: true }
			logsChannelSecret: { source: 'db', mutable: true }
			name: { source: 'db', mutable: true }
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
			console.error(err)
			atomicWritePossible = false
			return @constants.configJsonNonAtomicPath
		.then (path) =>
			if atomicWritePossible
				writeAndSyncFile("#{path}.new", JSON.stringify(@configJsonCache))
				.then ->
					fs.renameAsync("#{path}.new", path)
			else
				writeAndSyncFile(path, JSON.stringify(@configJsonCache))


	configJsonSet: (keyVals) =>
		changed = false
		Promise.using @writeLockConfigJson(), =>
			Promise.mapSeries _.keys(keyVals), (key) =>
				value = keyVals[key]
				if @configJsonCache[key] != value
					@configJsonCache[key] = value
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
		Promise.resolve(@configPath) if @configPath?
		@configJsonPathOnHost()
		.catch (err) =>
			console.error(err)
			return @constants.configJsonNonAtomicPath

		# Check OS version
	readConfigJson: =>
		@configJsonPath()
		.then (path) ->
			fs.readFileAsync(path)
			.then(JSON.parse)

	generateRequiredFields: =>
		@getMany([ 'uuid', 'deviceApiKey', 'apiSecret', 'logsChannelSecret' ])
		.spread (uuid, deviceApiKey, apiSecret, logsChannelSecret) =>
			if !uuid? or !deviceApiKey? or !apiSecret? or !logsChannelSecret?
				uuid ?= deviceRegister.generateUniqueKey()
				deviceApiKey ?= deviceRegister.generateUniqueKey()
				apiSecret ?= deviceRegister.generateUniqueKey()
				logsChannelSecret ?= deviceRegister.generateUniqueKey()
				@set({ uuid, deviceApiKey, apiSecret, logsChannelSecret })


	get: (key) =>
		# Get value for "key" from config.json or db
		Promise.try =>
			switch @schema[key]?.source
				when undefined
					throw new Error("Unknown config value #{key}")
				when 'func'
					@funcs[key]()
				when 'config.json'
					Promise.using @readLockConfigJson, =>
						return @configJsonCache[key]
				when 'db'
					@db('config').select('value').where({ key })
					.then ([ conf ]) ->
						return conf?.value
		.then (value) =>
			if !value? and @schema[key]?.default?
				return @schema[key].default
			return value

	getMany: (keys) =>
		# Get the values for several keys in an array
		Promise.all(_.map(keys, @get))

	# Sets config values as atomically as possible
	# Is atomic if all values have the same source, otherwise it's atomic for each source
	set: (keyValues) =>
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

			dbKeys = _.keys(dbVals)
			@getMany(dbKeys)
			.then (oldValues) =>
				@db.transaction (trx) =>
					Promise.map dbKeys, (key, idx) ->
						value = dbVals[key]
						if oldValues[idx] != value
							trx('config').update({ value }).where({ key })
							.then (n) ->
								trx('config').insert({ key, value }) if n == 0
					.then =>
						@configJsonSet(configJsonVals) if !_.isEmpty(configJsonVals)

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
					@db('config').del().where({ key })

	init: =>
		# Read config.json and cache its values
		# get or generate apiSecret, logsChannelSecret, uuid
		@readConfigJson()
		.then (configJson) =>
			_.assign(@configJsonCache, configJson)
		.then =>
			# get or generate uuid, apiSecret, logsChannelSecret
			@generateRequiredFields()
