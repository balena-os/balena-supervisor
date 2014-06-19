Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))
os = require 'os'
knex = require './db'
utils = require './utils'
{spawn} = require 'child_process'
bootstrap = require './bootstrap'

utils.mixpanelTrack('Supervisor start')

knex('config').select('value').where(key: 'uuid').then ([uuid]) ->
	if not uuid?.value
		console.log('New device detected. Bootstrapping..')
		utils.mixpanelTrack('Device bootstrap')
		bootstrap()
	else
		uuid.value
.then (uuid) ->
	# Persist the uuid in subsequent metrics
	utils.mixpanelProperties.uuid = uuid

	api = require './api'
	application = require './application'
	supervisor = require './supervisor-update'

	console.log('Starting OpenVPN..')
	openvpn = spawn('openvpn', ['client.conf'], cwd: '/data')

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
		Promise.all(apps.map(application.restart))
	.catch (error) ->
		console.error("Error starting apps:", error)
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

