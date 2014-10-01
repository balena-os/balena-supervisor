Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))
os = require 'os'
knex = require './db'
utils = require './utils'
{spawn} = require 'child_process'
bootstrap = require './bootstrap'
config = require './config'

utils.mixpanelTrack('Supervisor start')

connectivityState = true # Used to prevent multiple messages when disconnected

ensureConnected = (continuous = false) ->
	utils.checkConnectivity()
	.then (connected) ->
		if not connected
			if connectivityState
				console.log('Waiting for connectivity...')
				connectivityState = false
			interval = setInterval(utils.blink,400)
			Promise.delay(2000)
			.then ->
				# Clear the blinks after 2 second
				clearInterval(interval)
				ensureConnected(continuous)
		else
			if not connectivityState
				console.log('Internet Connectivity: OK')
				connectivityState = true
			if continuous
				setTimeout(->
					ensureConnected(continuous)
				, 10 * 1000) # Every 10 seconds perform this check.


knex('config').select('value').where(key: 'uuid').then ([ uuid ]) ->
	if not uuid?.value
		console.log('New device detected. Bootstrapping..')
		retryingBootstrap = ->
			utils.mixpanelTrack('Device bootstrap')
			bootstrap().catch (err) ->
				utils.mixpanelTrack("Device bootstrap failed due to #{err?.message}, retrying in #{config.bootstrapRetryDelay}ms")
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
		console.log('Starting periodic check for updates..')
		setInterval(->
			application.update()
		, 5 * 60 * 1000) # Every 5 mins
		application.update()

	console.log('Starting periodic check for supervisor updates..')
	setInterval(->
		supervisor.update()
	, 5 * 60 * 1000) # Every 5 mins
	supervisor.update()

	updateIpAddr = ->
		utils.findIpAddrs().then (ipAddrs) ->
			application.updateDeviceInfo(
				ip_address: ipAddrs.join(' ')
			)
	console.log('Starting periodic check for IP addresses..')
	setInterval(updateIpAddr, 5 * 60 * 1000) # Every 5 mins
	updateIpAddr()

	console.log('Starting connectivity check..')
	ensureConnected(true)

	# Let the previous supervisor know that we started successfully
	console.log(config.successMessage)
