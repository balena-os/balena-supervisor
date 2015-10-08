Promise = require 'bluebird'
_ = require 'lodash'
knex = require './db'
utils = require './utils'
deviceRegister = require 'resin-register-device'
{ resinApi } = require './request'
fs = Promise.promisifyAll(require('fs'))
EventEmitter = require('events').EventEmitter
config = require './config'
configPath = '/boot/config.json'
appsPath  = '/boot/apps.json'
userConfig = {}

DuplicateUuidError = (err) ->
	return err.message == '"uuid" must be unique.'

bootstrapper = {}

loadPreloadedApps = ->
	knex('app').truncate()
	.then ->
		fs.readFileAsync(appsPath, 'utf8')
	.then(JSON.parse)
	.map (app) ->
		utils.extendEnvVars(app.env, userConfig.uuid)
		.then (extendedEnv) ->
			app.env = JSON.stringify(extendedEnv)
			knex('app').insert(app)
	.catch (err) ->
		utils.mixpanelTrack('Loading preloaded apps failed', {error: err})

bootstrap = ->
	Promise.try ->
		userConfig.deviceType ?= 'raspberry-pi'
		if userConfig.registered_at?
			return userConfig
		deviceRegister.register(resinApi, userConfig)
		.catch DuplicateUuidError, ->
			resinApi.get
				resource: 'device'
				options:
					filter:
						uuid: userConfig.uuid
				customOptions:
					apikey: userConfig.apiKey
			.then ([ device ]) ->
				return device
		.then (device) ->
			userConfig.registered_at = Date.now()
			userConfig.deviceId = device.id
			fs.writeFileAsync(configPath, JSON.stringify(userConfig))
		.return(userConfig)
	.then (userConfig) ->
		console.log('Finishing bootstrapping')
		Promise.all([
			knex('config').whereIn('key', ['uuid', 'apiKey', 'username', 'userId', 'version']).delete()
			.then ->
				knex('config').insert([
					{ key: 'uuid', value: userConfig.uuid }
					{ key: 'apiKey', value: userConfig.apiKey }
					{ key: 'username', value: userConfig.username }
					{ key: 'userId', value: userConfig.userId }
					{ key: 'version', value: utils.supervisorVersion }
				])
		])
		.tap ->
			bootstrapper.doneBootstrapping()

readConfigAndEnsureUUID = ->
	# Load config file
	fs.readFileAsync(configPath, 'utf8')
	.then(JSON.parse)
	.then (configFromFile) ->
		userConfig = configFromFile
		return userConfig.uuid if userConfig.uuid?
		deviceRegister.generateUUID()
		.then (uuid) ->
			userConfig.uuid = uuid
			fs.writeFileAsync(configPath, JSON.stringify(userConfig))
			.return(uuid)
	.catch (err) ->
		console.log('Error generating and saving UUID: ', err)
		Promise.delay(config.bootstrapRetryDelay)
		.then ->
			readConfigAndEnsureUUID()

bootstrapOrRetry = ->
	utils.mixpanelTrack('Device bootstrap')
	bootstrap().catch (err) ->
		utils.mixpanelTrack('Device bootstrap failed, retrying', {error: err, delay: config.bootstrapRetryDelay})
		setTimeout(bootstrapOrRetry, config.bootstrapRetryDelay)

bootstrapper.done = new Promise (resolve) ->
	bootstrapper.doneBootstrapping = ->
		bootstrapper.bootstrapped = true
		resolve(userConfig)

bootstrapper.bootstrapped = false
bootstrapper.startBootstrapping = ->
	knex('config').select('value').where(key: 'uuid')
	.then ([ uuid ]) ->
		if uuid?.value
			bootstrapper.doneBootstrapping()
			return uuid.value
		console.log('New device detected. Bootstrapping..')
		readConfigAndEnsureUUID()
		.tap ->
			loadPreloadedApps()
		.tap ->
			bootstrapOrRetry()

module.exports = bootstrapper
