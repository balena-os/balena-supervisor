Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))
os = require 'os'
api = require './api'
knex = require './db'
utils = require './utils'
crypto = require 'crypto'
{spawn} = require 'child_process'
bootstrap = require './bootstrap'
application = require './application'

console.log('Supervisor started..')

newUuid = utils.getDeviceUuid()
oldUuid = knex('config').select('value').where(key: 'uuid')

Promise.all([newUuid, oldUuid])
.then ([newUuid, [oldUuid]]) ->
	oldUuid = oldUuid?.value
	if newUuid is oldUuid
		return true

	console.log('New device detected. Bootstrapping..')
	return bootstrap(newUuid)
.then ->
	console.log('Starting OpenVPN..')
	openvpn = spawn('openvpn', ['client.conf'], cwd: '/supervisor/data')

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
		, 15 * 60 * 1000) # Every 15 mins
		application.update()
