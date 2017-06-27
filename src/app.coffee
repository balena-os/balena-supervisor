require('log-timestamp')
process.on 'uncaughtException', (e) ->
	console.error('Got unhandled exception', e, e?.stack)

Promise = require 'bluebird'
utils = require './utils'
bootstrap = require './bootstrap'
_ = require 'lodash'
mixpanel = require './mixpanel'
iptables = require './lib/iptables'
network = require './network'


Knex = require('./db')
Config = require('./config')
ApiBinder = require('./api-binder')
DeviceState = require('./device-state')

supervisorInit = ->
	db = new Knex()
	config = new Config({ db })
	apiBinder = new ApiBinder({ config, db })
	deviceState = new DeviceState({ config, db })
	db.init()
	.then ->
		config.init() # Ensures uuid, deviceApiKey, apiSecret and logsChannel
	.then ->
		config.getMany([
			'uuid'
			'listenPort'
			'version'
			'apiSecret'
			'logsChannelSecret'
			'provisioned'
			'apiEndpoint'
			'offlineMode'
			'mixpanelToken'
			'username'
		])
	.spread (uuid, listenPort, version, apiSecret, logsChannelSecret, provisioned, apiEndpoint, offlineMode, mixpanelToken, username) ->
		mixpanel.init({
			offlineMode
			mixpanelToken
			username
			uuid
		})
		.then ->
			mixpanel.track('Supervisor start')
			network.connectivityCheck(apiEndpoint)
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
				# Todo: move to a separate module
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
			.then ->
				deviceState.init()
			.then ->
				deviceState.loadTargetsFromFile() if !provisioned
			.then ->
				deviceState.applyAndMaintainTarget()
			.then ->
				# initialize API
				console.log('Starting API server..')
				iptables.rejectOnAllInterfacesExcept(config.constants.allowedInterfaces, listenPort)
				.then ->
					apiServer = api(application).listen(listenPort)
					apiServer.timeout = apiTimeout
			.then ->
				apiBinder.init() # this will first try to provision if it's a new device

supervisorInit()
