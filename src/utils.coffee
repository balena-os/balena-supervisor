Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
constants = require './constants'
knex = require './db'
{ request } = require './request'
logger = require './lib/logger'
TypedError = require 'typed-error'
device = require './device'
{ checkTruthy } = require './lib/validation'

# Move to lib/logger
# Callback function to enable/disable logs
exports.resinLogControl = (val) ->
	logEnabled = checkTruthy(val) ? true
	logger.disableLogPublishing(!logEnabled)
	console.log('Logs enabled: ' + val)

# Move to gosuper.coffee
emptyHostRequest = request.defaults({ headers: Host: '' })
gosuperRequest = (method, endpoint, options = {}, callback) ->
	if _.isFunction(options)
		callback = options
		options = {}
	options.method = method
	options.url = constants.gosuperAddress + endpoint
	emptyHostRequest(options, callback)

gosuperPost = _.partial(gosuperRequest, 'POST')
gosuperGet = _.partial(gosuperRequest, 'GET')

exports.gosuper = gosuper =
	post: gosuperPost
	get: gosuperGet
	postAsync: Promise.promisify(gosuperPost, multiArgs: true)
	getAsync: Promise.promisify(gosuperGet, multiArgs: true)

# Callback function to enable/disable VPN
exports.vpnControl = (val) ->
	enable = checkTruthy(val) ? true
	gosuper.postAsync('/v1/vpncontrol', { json: true, body: Enable: enable })
	.spread (response, body) ->
		if response.statusCode == 202
			console.log('VPN enabled: ' + enable)
		else
			console.log('Error: ' + body + ' response:' + response.statusCode)

exports.AppNotFoundError = class AppNotFoundError extends TypedError

exports.getKnexApp = (appId, columns) ->
	knex('app').select(columns).where({ appId })
	.then ([ app ]) ->
		if !app?
			throw new AppNotFoundError('App not found')
		return app

exports.getKnexApps = (columns) ->
	knex('app').select(columns)
