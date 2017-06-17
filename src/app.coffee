require('log-timestamp')
process.on 'uncaughtException', (e) ->
	console.error('Got unhandled exception', e, e?.stack)

Promise = require 'bluebird'
knex = require './db'
utils = require './utils'
bootstrap = require './bootstrap'
config = require './config'
_ = require 'lodash'
mixpanel = require './mixpanel'

supervisorInit = ->
	knex.init.then ->
		config.init # Ensures uuid, deviceApiKey, apiSecret and logsChannel
	.then ->
		mixpanel.init
	.then ->
		mixpanel.track('Supervisor start')
		network.connectivityCheck()
		config.getMany(['uuid', 'listenPort', 'version', 'apiSecret', 'logsChannelSecret', 'provisioned'])
	.spread (uuid, listenPort, version, apiSecret, logsChannelSecret, provisioned) ->
		Promise.join(
			device.getOSVersion()
			device.getOSVariant()
			(osVersion, osVariant) ->
				# Let API know what version we are, and our api connection info.
				console.log('Updating supervisor version and api info')
				device.updateState(
					api_port: listenPort
					api_secret: apiSecret
					os_version: osVersion
					os_variant: osVariant
					supervisor_version: version
					provisioning_progress: null
					provisioning_state: ''
					download_progress: null
					logs_channel: logsChannelSecret
				)
		)
		.then ->
			application.loadTargetsFromFile() if !provisioned
		.then ->
			application.initialize()
		.then ->
			# initialize API
			console.log('Starting API server..')
			utils.createIpTablesRules()
			.then ->
				apiServer = api(application).listen(config.listenPort)
				apiServer.timeout = config.apiTimeout
		.then ->
			if !config.get('offlineMode')
				apiBinder.initialize() # this will first try to provision if it's a new device

knex.init.then ->
	utils.mixpanelTrack('Supervisor start')

	console.log('Starting connectivity check..')
	utils.connectivityCheck()

	Promise.join bootstrap.startBootstrapping(), utils.getOrGenerateSecret('api'), utils.getOrGenerateSecret('logsChannel'), (uuid, secret, logsChannel) ->
		# Persist the uuid in subsequent metrics
		utils.mixpanelProperties.uuid = uuid
		utils.mixpanelProperties.distinct_id = uuid

		api = require './api'
		application = require('./application')(logsChannel, bootstrap.offlineMode)
		device = require './device'

		console.log('Starting API server..')
		utils.createIpTablesRules()
		.then ->
			apiServer = api(application).listen(config.listenPort)
			apiServer.timeout = config.apiTimeout

		bootstrap.done
		.then ->
			Promise.join(
				device.getOSVersion()
				device.getOSVariant()
				(osVersion, osVariant) ->
					# Let API know what version we are, and our api connection info.
					console.log('Updating supervisor version and api info')
					device.updateState(
						api_port: config.listenPort
						api_secret: secret
						os_version: osVersion
						os_variant: osVariant
						supervisor_version: utils.supervisorVersion
						provisioning_progress: null
						provisioning_state: ''
						download_progress: null
						logs_channel: logsChannel
					)
			)

			updateIpAddr = ->
				utils.gosuper.getAsync('/v1/ipaddr', { json: true })
				.spread (response, body) ->
					if response.statusCode == 200 && body.Data.IPAddresses?
						device.updateState(
							ip_address: body.Data.IPAddresses.join(' ')
						)
				.catch(_.noop)
			console.log('Starting periodic check for IP addresses..')
			setInterval(updateIpAddr, 30 * 1000) # Every 30s
			updateIpAddr()

		console.log('Starting Apps..')
		application.initialize()
