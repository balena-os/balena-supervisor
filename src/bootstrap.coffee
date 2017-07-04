Promise = require 'bluebird'
knex = require './db'
utils = require './utils'
deviceRegister = require 'resin-register-device'
{ resinApi, request } = require './request'
fs = Promise.promisifyAll(require('fs'))
config = require './config'
configPath = '/boot/config.json'
appsPath  = '/boot/apps.json'
_ = require 'lodash'
deviceConfig = require './device-config'
TypedError = require 'typed-error'
osRelease = require './lib/os-release'
semver = require 'semver'
semverRegex = require('semver-regex')

userConfig = {}

DuplicateUuidError = message: '"uuid" must be unique.'
exports.ExchangeKeyError = class ExchangeKeyError extends TypedError

bootstrapper = {}

writeAndSyncFile = (path, data) ->
	fs.openAsync(path, 'w')
	.then (fd) ->
		fs.writeAsync(fd, data, 0, 'utf8')
		.then ->
			fs.fsyncAsync(fd)
		.then ->
			fs.closeAsync(fd)

loadPreloadedApps = ->
	devConfig = {}
	knex('app').truncate()
	.then ->
		fs.readFileAsync(appsPath, 'utf8')
	.then(JSON.parse)
	.map (app) ->
		utils.extendEnvVars(app.env, userConfig.uuid, app.appId, app.name, app.commit)
		.then (extendedEnv) ->
			app.env = JSON.stringify(extendedEnv)
			_.merge(devConfig, app.config)
			app.config = JSON.stringify(app.config)
			knex('app').insert(app)
	.then ->
		deviceConfig.set({ targetValues: devConfig })
	.catch (err) ->
		utils.mixpanelTrack('Loading preloaded apps failed', { error: err })

fetchDevice = (apiKey) ->
	resinApi.get
		resource: 'device'
		options:
			filter:
				uuid: userConfig.uuid
		customOptions:
			apikey: apiKey
	.get(0)
	.catchReturn(null)
	.timeout(config.apiTimeout)

exchangeKey = ->
	Promise.try ->
		# If we have an existing device key we first check if it's valid, because if it is we can just use that
		if userConfig.deviceApiKey?
			fetchDevice(userConfig.deviceApiKey)
	.then (device) ->
		if device?
			return device
		# If it's not valid/doesn't exist then we try to use the user/provisioning api key for the exchange
		fetchDevice(userConfig.apiKey)
		.then (device) ->
			if not device?
				throw new ExchangeKeyError("Couldn't fetch device with provisioning key")
			# We found the device, we can try to register a working device key for it
			userConfig.deviceApiKey ?= deviceRegister.generateUniqueKey()
			request.postAsync("#{config.apiEndpoint}/api-key/device/#{device.id}/device-key?apikey=#{userConfig.apiKey}", {
				json: true
				body:
					apiKey: userConfig.deviceApiKey
			})
			.spread (res, body) ->
				if res.statusCode != 200
					throw new ExchangeKeyError("Couldn't register device key with provisioning key")
			.return(device)

bootstrap = ->
	Promise.try ->
		userConfig.deviceType ?= 'raspberry-pi'
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
			userConfig.registered_at = Date.now()
			userConfig.deviceId = id
			osRelease.getOSVersion(config.hostOSVersionPath)
		.then (osVersion) ->
			# Delete the provisioning key now, only if the OS supports it
			hasSupport = hasDeviceApiKeySupport(osVersion)
			if hasSupport
				delete userConfig.apiKey
			else
				userConfig.apiKey = userConfig.deviceApiKey
			writeAndSyncFile(configPath, JSON.stringify(userConfig))
		.return(userConfig)
	.then (userConfig) ->
		console.log('Finishing bootstrapping')
		knex('config').whereIn('key', ['uuid', 'apiKey', 'username', 'userId', 'version']).delete()
		.then ->
			knex('config').insert([
				{ key: 'uuid', value: userConfig.uuid }
				# We use the provisioning/user `apiKey` if it still exists because if it does it means we were already registered
				# using that key and have to rely on the exchange key mechanism to swap the keys as appropriate later
				{ key: 'apiKey', value: userConfig.apiKey ? userConfig.deviceApiKey }
				{ key: 'username', value: userConfig.username }
				{ key: 'userId', value: userConfig.userId }
				{ key: 'version', value: utils.supervisorVersion }
			])
		.tap ->
			bootstrapper.doneBootstrapping()

readConfig = ->
	fs.readFileAsync(configPath, 'utf8')
	.then(JSON.parse)

generateRegistration = (forceReregister = false) ->
	Promise.try ->
		if forceReregister
			userConfig.uuid = deviceRegister.generateUniqueKey()
			userConfig.deviceApiKey = deviceRegister.generateUniqueKey()
		else
			userConfig.uuid ?= deviceRegister.generateUniqueKey()
			userConfig.deviceApiKey ?= deviceRegister.generateUniqueKey()
		writeAndSyncFile(configPath, JSON.stringify(userConfig))
		.return(userConfig.uuid)
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

bootstrapper.done = new Promise (resolve) ->
	bootstrapper.doneBootstrapping = ->
		bootstrapper.bootstrapped = true
		resolve(userConfig)
		# If we're still using an old api key we can try to exchange it for a valid device key
		# This will only be the case when the supervisor/OS has been updated.
		if userConfig.apiKey?
			# Only do a key exchange and delete the provisioning key if we're on a Resin OS version
			# that supports using the deviceApiKey (2.0.2 and above)
			# or if we're in a non-Resin OS (which is assumed to be updated enough).
			# Otherwise VPN and other host services that use an API key will break.
			#
			# In other cases, we make the apiKey equal the deviceApiKey instead.
			osRelease.getOSVersion(config.hostOSVersionPath)
			.then (osVersion) ->
				hasSupport = hasDeviceApiKeySupport(osVersion)
				if hasSupport or userConfig.apiKey != userConfig.deviceApiKey
					console.log('Attempting key exchange')
					exchangeKey()
					.then ->
						console.log('Key exchange succeeded, starting to use deviceApiKey')
						if hasSupport
							delete userConfig.apiKey
						else
							userConfig.apiKey = userConfig.deviceApiKey
						utils.setConfig('apiKey', userConfig.deviceApiKey)
					.then ->
						writeAndSyncFile(configPath, JSON.stringify(userConfig))
			# We return immediately, and eventually the API key will be exchanged and replaced.
			return

bootstrapper.bootstrapped = false
bootstrapper.startBootstrapping = ->
	# Load config file
	readConfig()
	.then (configFromFile) ->
		userConfig = configFromFile
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
			if bootstrapper.offlineMode
				return knex('config').insert({ key: 'uuid', value: uuid })
			else
				bootstrapOrRetry()
				# Don't wait on bootstrapping here, bootstrapper.done is for that.
				return

module.exports = bootstrapper
