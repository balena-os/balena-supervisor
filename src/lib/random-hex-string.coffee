Promise = require('bluebird')
crypto = require('crypto')

exports.generate = (length = 32, callback) ->
	Promise.try ->
		crypto.randomBytes(length).toString('hex')
	.catch ->
		Promise.delay(1).then(exports.generate)
	.nodeify(callback)
