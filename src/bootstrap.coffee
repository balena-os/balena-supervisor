Promise = require 'bluebird'
knex = require './db'
utils = require './utils'
deviceRegister = require 'resin-register-device'
{ resinApi, request } = require './request'
fs = Promise.promisifyAll(require('fs'))
config = require './config'
appsPath  = '/boot/apps.json'
_ = require 'lodash'
deviceConfig = require './device-config'
TypedError = require 'typed-error'
osRelease = require './lib/os-release'
semver = require 'semver'
semverRegex = require('semver-regex')
configJson = require './config-json'

DuplicateUuidError = (err) -> _.startsWith(err.message, '"uuid" must be unique')
exports.ExchangeKeyError = class ExchangeKeyError extends TypedError

bootstrapper = {}

loadPreloadedApps = ->
	devConfig = {}
	knex('app').select()
	.then (apps) ->
		if apps.length > 0
			console.log('Preloaded apps already loaded, skipping')
			return
		configJson.getAll()
		.then (userConfig) ->
			fs.readFileAsync(appsPath, 'utf8')
			.then(JSON.parse)
			.map (app) ->
				utils.extendEnvVars(app.env, userConfig.uuid, userConfig.deviceApiKey, app.appId, app.name, app.commit)
				.then (extendedEnv) ->
					app.env = JSON.stringify(extendedEnv)
					app.markedForDeletion = false
					_.merge(devConfig, app.config)
					app.config = JSON.stringify(app.config)
					knex('app').insert(app)
			.then ->
				deviceConfig.set({ targetValues: devConfig })
		.catch (err) ->
			utils.mixpanelTrack('Loading preloaded apps failed', { error: err })

fetchDevice = (uuid, apiKey) ->
	resinApi.get
		resource: 'device'
		options:
			filter:
				uuid: uuid
		customOptions:
			apikey: apiKey
	.get(0)
	.catchReturn(null)
	.timeout(config.apiTimeout)

exchangeKey = ->
	configJson.getAll()
	.then (userConfig) ->
		Promise.try ->
			# If we have an existing device key we first check if it's valid, because if it is we can just use that
			if userConfig.deviceApiKey?
				fetchDevice(userConfig.uuid, userConfig.deviceApiKey)
		.then (device) ->
			if device?
				return device
			# If it's not valid/doesn't exist then we try to use the user/provisioning api key for the exchange
			fetchDevice(userConfig.uuid, userConfig.apiKey)
			.then (device) ->
				if not device?
					throw new ExchangeKeyError("Couldn't fetch device with provisioning key")
				# We found the device, we can try to register a working device key for it
				Promise.try ->
					if !userConfig.deviceApiKey?
						deviceApiKey = deviceRegister.generateUniqueKey()
						configJson.set({ deviceApiKey })
						.return(deviceApiKey)
					else
						return userConfig.deviceApiKey
				.then (deviceApiKey) ->
					request.postAsync("#{config.apiEndpoint}/api-key/device/#{device.id}/device-key?apikey=#{userConfig.apiKey}", {
						json: true
						body:
							apiKey: deviceApiKey
					})
				.spread (res, body) ->
					if res.statusCode != 200
						throw new ExchangeKeyError("Couldn't register device key with provisioning key")
				.return(device)

bootstrap = ->
	configJson.get('deviceType')
	.then (deviceType) ->
		if !deviceType?
			configJson.set(deviceType: 'raspberry-pi')
	.then ->
		configJson.getAll()
	.then (userConfig) ->
		if userConfig.registered_at?
			return userConfig

		deviceRegister.register(
			userId: userConfig.userId
			applicationId: userConfig.applicationId
			uuid: userConfig.uuid
			deviceType: userConfig.deviceType
			deviceApiKey: userConfig.deviceApiKey
			provisioningApiKey: userConfig.apiKey
			apiEndpoint: config.apiEndpoint
		)
		.timeout(config.apiTimeout)
		.catch DuplicateUuidError, ->
			console.log('UUID already registered, trying a key exchange')
			exchangeKey()
			.tap ->
				console.log('Key exchange succeeded, all good')
			.tapCatch ExchangeKeyError, (err) ->
				# If it fails we just have to reregister as a provisioning key doesn't have the ability to change existing devices
				console.log('Exchanging key failed, having to reregister')
				generateRegistration(true)
		.then ({ id }) ->
			toUpdate = {}
			toDelete = []
			if !userConfig.registered_at?
				toUpdate.registered_at = Date.now()
			toUpdate.deviceId = id
			osRelease.getOSVersion(config.hostOSVersionPath)
			.then (osVersion) ->
				# Delete the provisioning key now, only if the OS supports it
				hasSupport = hasDeviceApiKeySupport(osVersion)
				if hasSupport
					toDelete.push('apiKey')
				else
					toUpdate.apiKey = userConfig.deviceApiKey
				configJson.set(toUpdate, toDelete)
		.then ->
			configJson.getAll()
	.then (userConfig) ->
		console.log('Finishing bootstrapping')
		knex('config').whereIn('key', ['uuid', 'apiKey', 'username', 'userId', 'version']).delete()
		.then ->
			knex('config').insert([
				{ key: 'uuid', value: userConfig.uuid }
				# We use the provisioning/user `apiKey` if it still exists because if it does it means we were already registered
				# using that key and have to rely on the exchange key mechanism to swap the keys as appropriate later
				{ key: 'apiKey', value: userConfig.apiKey ? userConfig.deviceApiKey }
				{ key: 'deviceApiKey', value: userConfig.deviceApiKey }
				{ key: 'username', value: userConfig.username }
				{ key: 'userId', value: userConfig.userId }
				{ key: 'version', value: utils.supervisorVersion }
			])
		.tap ->
			bootstrapper.doneBootstrapping()

generateRegistration = (forceReregister = false) ->
	Promise.try ->
		if forceReregister
			configJson.set({ uuid: deviceRegister.generateUniqueKey(), deviceApiKey: deviceRegister.generateUniqueKey() })
		else
			configJson.getAll()
			.then ({ uuid, deviceApiKey }) ->
				uuid ?= deviceRegister.generateUniqueKey()
				deviceApiKey ?= deviceRegister.generateUniqueKey()
				configJson.set({ uuid, deviceApiKey })
	.then ->
		configJson.get('uuid')
	.catch (err) ->
		console.log('Error generating and saving UUID: ', err)
		Promise.delay(config.bootstrapRetryDelay)
		.then ->
			generateRegistration()

bootstrapOrRetry = ->
	utils.mixpanelTrack('Device bootstrap')
	# If we're in offline mode, we don't start the provisioning process so bootstrap.done will never fulfill
	return if bootstrapper.offlineMode
	bootstrap().catch (err) ->
		utils.mixpanelTrack('Device bootstrap failed, retrying', { error: err, delay: config.bootstrapRetryDelay })
		setTimeout(bootstrapOrRetry, config.bootstrapRetryDelay)

hasDeviceApiKeySupport = (osVersion) ->
	try
		!/^Resin OS /.test(osVersion) or semver.gte(semverRegex().exec(osVersion)[0], '2.0.2')
	catch err
		console.error('Unable to determine if device has deviceApiKey support', err, err.stack)
		false

exchangeKeyAndUpdateConfig = ->
	# Only do a key exchange and delete the provisioning key if we're on a Resin OS version
	# that supports using the deviceApiKey (2.0.2 and above)
	# or if we're in a non-Resin OS (which is assumed to be updated enough).
	# Otherwise VPN and other host services that use an API key will break.
	#
	# In other cases, we make the apiKey equal the deviceApiKey instead.
	Promise.join(
		configJson.getAll()
		osRelease.getOSVersion(config.hostOSVersionPath)
		(userConfig, osVersion) ->
			hasSupport = hasDeviceApiKeySupport(osVersion)
			if hasSupport or userConfig.apiKey != userConfig.deviceApiKey
				console.log('Attempting key exchange')
				exchangeKey()
				.then ->
					configJson.get('deviceApiKey')
				.then (deviceApiKey) ->
					console.log('Key exchange succeeded, starting to use deviceApiKey')
					utils.setConfig('deviceApiKey', deviceApiKey)
					.then ->
						utils.setConfig('apiKey', deviceApiKey)
					.then ->
						if hasSupport
							configJson.set({}, [ 'apiKey' ])
						else
							configJson.set(apiKey: deviceApiKey)
	)

exchangeKeyOrRetry = do ->
	_failedExchanges = 0
	return ->
		exchangeKeyAndUpdateConfig()
		.catch (err) ->
			console.error('Error exchanging API key, will retry', err, err.stack)
			delay = Math.min((2 ** _failedExchanges) * config.bootstrapRetryDelay, 24 * 60 * 60 * 1000)
			_failedExchanges += 1
			setTimeout(exchangeKeyOrRetry, delay)
		return

bootstrapper.done = new Promise (resolve) ->
	bootstrapper.doneBootstrapping = ->
		configJson.getAll()
		.then (userConfig) ->
			bootstrapper.bootstrapped = true
			resolve(userConfig)
			# If we're still using an old api key we can try to exchange it for a valid device key
			# This will only be the case when the supervisor/OS has been updated.
			if userConfig.apiKey?
				exchangeKeyOrRetry()
			else
				Promise.join(
					knex('config').select('value').where(key: 'apiKey')
					knex('config').select('value').where(key: 'deviceApiKey')
					([ apiKey ], [ deviceApiKey ]) ->
						if !deviceApiKey?.value
							# apiKey in the DB is actually the deviceApiKey, but it was
							# exchanged in a supervisor version that didn't save it to the DB
							# (which mainly affects the RESIN_API_KEY env var)
							knex('config').insert({ key: 'deviceApiKey', value: apiKey.value })
				)
		return

bootstrapper.bootstrapped = false
bootstrapper.startBootstrapping = ->
	# Load config file
	configJson.init()
	.then ->
		configJson.getAll()
	.then (userConfig) ->
		bootstrapper.offlineMode = !Boolean(config.apiEndpoint) or Boolean(userConfig.supervisorOfflineMode)
		knex('config').select('value').where(key: 'uuid')
	.then ([ uuid ]) ->
		if uuid?.value
			bootstrapper.doneBootstrapping() if !bootstrapper.offlineMode
			return uuid.value
		console.log('New device detected. Bootstrapping..')

		generateRegistration()
		.tap ->
			loadPreloadedApps()
		.tap (uuid) ->
			bootstrapOrRetry() if !bootstrapper.offlineMode
			# Don't wait on bootstrapping here, bootstrapper.done is for that.
			return

module.exports = bootstrapper
