Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
url = require 'url'
knex = require './db'
utils = require './utils'
crypto = require 'crypto'
config = require './config'
csrgen = Promise.promisify require 'csr-gen'
request = Promise.promisify require 'request'

module.exports = ->
	# Load config file
	config = fs.readFileAsync('/boot/config.json', 'utf8').then(JSON.parse)

	version = utils.getSupervisorVersion()

	# I'd be nice if the UUID matched the output of a SHA-256 function, but
	# although the length limit of the CN attribute in a X.509 certificate is
	# 64 chars, a 32 byte UUID (64 chars in hex) doesn't pass the certificate
	# validation in OpenVPN This either means that the RFC counts a final NULL
	# byte as part of the CN or that the OpenVPN/OpenSSL implementation has a
	# bug.
	uuid = crypto.pseudoRandomBytes(31).toString('hex')

	# Generate SSL certificate
	keys = csrgen(uuid,
		company: 'Rulemotion Ltd'
		csrName: 'client.csr'
		keyName: 'client.key'
		outputDir: '/data'
		email: 'vpn@resin.io'
		read: true
		country: ''
		city: ''
		state: ''
		division: ''
	)

	Promise.all([config, keys, version])
	.then ([config, keys, version]) ->
		console.log('UUID:', uuid)
		console.log('User ID:', config.userId)
		console.log('User:', config.username)
		console.log('Supervisor Version:', version)
		console.log('API key:', config.apiKey)
		console.log('Application ID:', config.applicationId)
		console.log('CSR :', keys.csr)
		console.log('Posting to the API..')
		config.csr = keys.csr
		config.uuid = uuid
		config.version = version
		return request(
			method: 'POST'
			url: url.resolve(config.apiEndpoint, 'associate')
			json: config
		)
	.spread (response, body) ->
		if response.statusCode >= 400
			throw body

		console.log('Configuring VPN..')
		vpnConf = fs.readFileAsync(__dirname + '/openvpn.conf.tmpl', 'utf8')
			.then (tmpl) ->
				fs.writeFileAsync('/data/client.conf', _.template(tmpl)(body))

		Promise.all([
			fs.writeFileAsync('/data/ca.crt', body.ca)
			fs.writeFileAsync('/data/client.crt', body.cert)
			vpnConf
		])
	.then ->
		console.log('Finishing bootstrapping')
		Promise.all([
			knex('config').truncate()
			.then ->
				config
				.then (config) ->
					knex('config').insert([
						{key: 'uuid', value: uuid}
						{key: 'apiKey', value: config.apiKey}
						{key: 'username', value: config.username}
						{key: 'userId', value: config.userId}
						{key: 'version', value: version}
					])
			knex('app').truncate()
		])
