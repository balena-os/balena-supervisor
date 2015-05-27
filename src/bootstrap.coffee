Promise = require 'bluebird'
_ = require 'lodash'
knex = require './db'
utils = require './utils'
deviceRegister = require 'resin-register-device'
{ resinApi } = require './request'
fs = Promise.promisifyAll(require('fs'))

module.exports = ->
	# Load config file
	fs.readFileAsync('/boot/config.json', 'utf8')
	.then(JSON.parse)
	.then (userConfig) ->
		userConfig.deviceType ?= 'raspberry-pi'
		if userConfig.uuid? and userConfig.registered_at?
			return userConfig
		deviceRegister.register(resinApi, userConfig)
		.then (device) ->
			userConfig.uuid = device.uuid
			userConfig.registered_at = Date.now()
			userConfig.deviceId = device.id
			fs.writeFileAsync('/boot/config.json', JSON.stringify(userConfig))
		.return(userConfig)
	.then (userConfig) ->
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
		.return(userConfig.uuid)
