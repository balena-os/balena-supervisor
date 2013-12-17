Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))
os = require 'os'
api = require './api'
knex = require './db'
utils = require './utils'
crypto = require 'crypto'
{spawn} = require 'child_process'
bootstrap = require './bootstrap'

console.log('Supervisor started..')

newUuid = utils.getDeviceUuid()
oldUuid = knex('config').select('value').where(key: 'uuid')

bootstrap = Promise.all([newUuid, oldUuid]).then(([newUuid, [oldUuid]]) ->
	if newUuid is oldUuid
		return true

	console.log('New device detected. Bootstrapping..')
	return bootstrap(newUuid)
)

bootstrap.then(->
	console.log('Starting OpenVPN..')
	openvpn = spawn('openvpn', ['client.conf'], cwd: '/supervisor/data')

	# Prefix and log all OpenVPN output
	openvpn.stdout.on('data', (data) ->
		prefix = 'OPENVPN: '
		console.log((prefix + data).trim().replace(/\n/gm, '\n#{prefix}'))
	)

	# Prefix and log all OpenVPN output
	openvpn.stderr.on('data', (data) ->
		prefix = 'OPENVPN: '
		console.log((prefix + data).trim().replace(/\n/gm, '\n#{prefix}'))
	)

	console.log('Start API server')
	api.listen(80)
)
