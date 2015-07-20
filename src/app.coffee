process.on 'uncaughtException', (e) ->
	console.error('Got unhandled exception', e, e?.stack)

Promise = require 'bluebird'
knex = require './db'
utils = require './utils'
bootstrap = require './bootstrap'
config = require './config'

knex.init.then ->
	utils.mixpanelTrack('Supervisor start')

	console.log('Starting connectivity check..')
	utils.connectivityCheck()

	knex('config').select('value').where(key: 'uuid').then ([ uuid ]) ->
		if not uuid?.value
			console.log('New device detected. Bootstrapping..')
			retryingBootstrap = ->
				utils.mixpanelTrack('Device bootstrap')
				bootstrap().catch (err) ->
					utils.mixpanelTrack('Device bootstrap failed, retrying', {error: err, delay: config.bootstrapRetryDelay})
					Promise.delay(config.bootstrapRetryDelay)
					.then(retryingBootstrap)
			retryingBootstrap()
		else
			uuid.value
	.then (uuid) ->
		# Persist the uuid in subsequent metrics
		utils.mixpanelProperties.uuid = uuid

		api = require './api'
		application = require './application'
		device = require './device'
		randomstring = require 'randomstring'

		console.log('Starting API server..')
		secret = randomstring.generate()
		api(secret).listen(config.listenPort)

		# Let API know what version we are, and our api connection info.
		console.log('Updating supervisor version and api info')
		device.updateState(
			api_port: config.listenPort
			api_secret: secret
			supervisor_version: utils.supervisorVersion
			provisioning_progress: null
			provisioning_state: ''
			download_progress: null
		)
	
		console.log('Starting Apps..')
		knex('app').select()
		.then (apps) ->
			Promise.all(apps.map(application.start))
		.catch (error) ->
			console.error('Error starting apps:', error)
		.then ->
			utils.mixpanelTrack('Start application update poll', {interval: config.appUpdatePollInterval})
			setInterval(->
				application.update()
			, config.appUpdatePollInterval)
			application.update()

		updateIpAddr = ->
			utils.findIpAddrs().then (ipAddrs) ->
				device.updateState(
					ip_address: ipAddrs.join(' ')
				)
		console.log('Starting periodic check for IP addresses..')
		setInterval(updateIpAddr, 30 * 1000) # Every 30s
		updateIpAddr()
