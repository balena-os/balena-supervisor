Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))
os = require 'os'
knex = require './db'
utils = require './utils'
{spawn} = require 'child_process'
bootstrap = require './bootstrap'
config = require './config'

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
	supervisor = require './supervisor-update'

	console.log('Starting OpenVPN..')
	openvpn = spawn('openvpn', [ 'client.conf' ], cwd: '/data')

	# Prefix and log all OpenVPN output
	openvpn.stdout.on 'data', (data) ->
		prefix = 'OPENVPN: '
		console.log((prefix + data).trim().replace(/\n/gm, "\n#{prefix}"))

	# Prefix and log all OpenVPN output
	openvpn.stderr.on 'data', (data) ->
		prefix = 'OPENVPN: '
		console.log((prefix + data).trim().replace(/\n/gm, "\n#{prefix}"))

	console.log('Starting API server..')
	api.listen(80)

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
			application.updateDeviceInfo(
				ip_address: ipAddrs.join(' ')
			)
	console.log('Starting periodic check for IP addresses..')
	setInterval(updateIpAddr, 30 * 1000) # Every 30s
	updateIpAddr()

	# Tell the supervisor updater that we have successfully started, so that it can do whatever it needs to.
	supervisor.startupSuccessful()

	# Let API know we are running a new version
	console.log('Updating supervisor version:', utils.supervisorVersion)
	application.updateDeviceInfo(
		supervisor_version: utils.supervisorVersion
	)
