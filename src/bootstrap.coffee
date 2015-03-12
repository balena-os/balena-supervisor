Promise = require 'bluebird'
_ = require 'lodash'
knex = require './db'
utils = require './utils'
crypto = require 'crypto'
{ resinApi } = require './request'
fs = Promise.promisifyAll(require('fs'))

registerDevice = (apiKey, userId, applicationId, deviceType, uuid) ->
	# I'd be nice if the UUID matched the output of a SHA-256 function, but although the length limit of the CN
	# attribute in a X.509 certificate is 64 chars, a 32 byte UUID (64 chars in hex) doesn't pass the certificate
	# validation in OpenVPN This either means that the RFC counts a final NULL byte as part of the CN or that the
	# OpenVPN/OpenSSL implementation has a bug.
	if not uuid?
		uuid = crypto.pseudoRandomBytes(31).toString('hex')

	resinApi.post(
		resource: 'device'
		body:
			user: userId
			application: applicationId
			uuid: uuid
			device_type: deviceType
		customOptions:
			apikey: apiKey
	).then (data) ->
		_.pick(data, 'id', 'uuid')

module.exports = ->
	# Load config file
	userConfig = require('/boot/config.json')
	userConfig.deviceType ?= 'raspberry-pi'

	Promise.try ->
		if userConfig.uuid? and userConfig.registered_at?
			return userConfig
		registerDevice(userConfig.apiKey, userConfig.userId, userConfig.applicationId, userConfig.deviceType, userConfig.uuid)
		.then (device) ->
			userConfig.uuid = device.uuid
			userConfig.deviceId = device.id
			fs.writeFileAsync('/boot/config.json', JSON.stringify(userConfig))
		.return(userConfig)
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
