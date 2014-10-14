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
PlatformAPI = require 'resin-platform-api/request'

PLATFORM_ENDPOINT = url.resolve(config.apiEndpoint, '/ewa/')
resinAPI = new PlatformAPI(PLATFORM_ENDPOINT)

registerDevice = (apiKey, userId, applicationId, deviceType) ->
	# I'd be nice if the UUID matched the output of a SHA-256 function, but although the length limit of the CN
	# attribute in a X.509 certificate is 64 chars, a 32 byte UUID (64 chars in hex) doesn't pass the certificate
	# validation in OpenVPN This either means that the RFC counts a final NULL byte as part of the CN or that the
	# OpenVPN/OpenSSL implementation has a bug.
	uuid = crypto.pseudoRandomBytes(31).toString('hex')

	resinAPI.post(
		resource: 'device'
		body:
			user: userId
			application: applicationId
			uuid: uuid
			'device_type': deviceType
		customOptions:
			apikey: apiKey
	).then ->
		return uuid

module.exports = ->
	# Load config file
	userConfig = require('/boot/config.json')
	userConfig.deviceType ?= 'Raspberry Pi'

	Promise.try ->
		if userConfig.uuid?
			return userConfig.uuid
		registerDevice(userConfig.apiKey, userConfig.userId, userConfig.applicationId, userConfig.deviceType)
		.tap (uuid) ->
			userConfig.uuid = uuid
	.then (uuid) ->
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

		return [keys, uuid]
	.spread (keys, uuid) ->
		console.log('UUID:', uuid)
		console.log('User ID:', userConfig.userId)
		console.log('User:', userConfig.username)
		console.log('Supervisor Version:', utils.supervisorVersion)
		console.log('API key:', userConfig.apiKey)
		console.log('Application ID:', userConfig.applicationId)
		console.log('CSR :', keys.csr)
		console.log('Posting to the API..')
		userConfig.csr = keys.csr
		userConfig.uuid = uuid
		return request(
			method: 'POST'
			url: url.resolve(config.apiEndpoint, 'sign_certificate?apikey=' + userConfig.apiKey)
			json: userConfig
		)
	.spread (response, body) ->
		if response.statusCode >= 400
			throw body

		console.log('Configuring VPN..', JSON.stringify(body))

		for prop in ['ca', 'cert', 'vpnhost', 'vpnport'] when _.isEmpty(body[prop])
			throw new Error("'#{prop}' is empty, cannot bootstrap")

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
				knex('config').insert([
					{ key: 'uuid', value: userConfig.uuid }
					{ key: 'apiKey', value: userConfig.apiKey }
					{ key: 'username', value: userConfig.username }
					{ key: 'userId', value: userConfig.userId }
					{ key: 'version', value: utils.supervisorVersion }
				])
			knex('app').truncate()
		])
