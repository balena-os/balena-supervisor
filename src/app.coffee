process.on 'uncaughtException', (e) ->
	console.error('Got unhandled exception', e, e?.stack)

Promise = require 'bluebird'
knex = require './db'
utils = require './utils'
bootstrap = require './bootstrap'
config = require './config'
request = require 'request'

knex.init.then ->
	utils.mixpanelTrack('Supervisor start')

	console.log('Starting connectivity check..')
	utils.connectivityCheck()

	bootstrap.startBootstrapping()
	.then (uuid) ->
		# Persist the uuid in subsequent metrics
		utils.mixpanelProperties.uuid = uuid

		api = require './api'
		application = require('./application')(uuid)
		device = require './device'
		randomHexString = require './lib/random-hex-string'

		bootstrap.done
		.then ->
			return config.forceApiSecret ? randomHexString.generate()
		.then (secret) ->
			console.log('Starting API server..')
			api(secret, application).listen(config.listenPort)
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
		application.initialize()

		updateIpAddr = ->
			callback = (error, response, body ) ->
				if !error && response.statusCode == 200
					device.updateState(
						ip_address: body.Data.IPAddresses.join(' ')
					)
			request.get({ url: "#{config.gosuperAddress}/v1/ipaddr", json: true }, callback )

		console.log('Starting periodic check for IP addresses..')
		setInterval(updateIpAddr, 30 * 1000) # Every 30s
		updateIpAddr()
