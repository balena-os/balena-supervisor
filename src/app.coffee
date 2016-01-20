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

	Promise.join bootstrap.startBootstrapping(), utils.getOrGenerateSecret('api'), utils.getOrGenerateSecret('logsChannel'), (uuid, secret, logsChannel) ->
		# Persist the uuid in subsequent metrics
		utils.mixpanelProperties.uuid = uuid

		api = require './api'
		application = require('./application')(logsChannel)
		device = require './device'

		bootstrap.done
		.then ->
			device.getOSVersion()
		.then (osVersion) ->
			console.log('Starting API server..')
			api(application).listen(config.listenPort)
			# Let API know what version we are, and our api connection info.
			console.log('Updating supervisor version and api info')
			device.updateState(
				api_port: config.listenPort
				api_secret: secret
				os_version: osVersion
				supervisor_version: utils.supervisorVersion
				provisioning_progress: null
				provisioning_state: ''
				download_progress: null
				logs_channel: logsChannel
			)

		console.log('Starting Apps..')
		application.initialize()

		updateIpAddr = ->
			callback = (error, response, body ) ->
				if !error && response.statusCode == 200 && body.Data.IPAddresses?
					device.updateState(
						ip_address: body.Data.IPAddresses.join(' ')
					)
			request.get({ url: "#{config.gosuperAddress}/v1/ipaddr", json: true }, callback )

		console.log('Starting periodic check for IP addresses..')
		setInterval(updateIpAddr, 30 * 1000) # Every 30s
		updateIpAddr()
