Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
config = require './config'
knex = require './db'
blink = require('blinking')(config.ledFile)
{ request } = require './request'
logger = require './lib/logger'
TypedError = require 'typed-error'
device = require './device'
{ checkTruthy } = require './lib/validation'

exports.supervisorVersion = require('./lib/supervisor-version')

exports.blink = blink

# Move to container-config.coffee
exports.extendEnvVars = (env, uuid, appId, appName, commit) ->
	config.getMany(['listenPort', 'name', 'apiSecret', 'deviceApiKey', 'version'])
	.spread (listenPort, name, apiSecret, deviceApiKey, version) ->
		host = '127.0.0.1'
		newEnv =
			RESIN_APP_ID: appId.toString()
			RESIN_APP_NAME: appName
			RESIN_APP_RELEASE: commit
			RESIN_DEVICE_UUID: uuid
			RESIN_DEVICE_NAME_AT_INIT: name
			RESIN_DEVICE_TYPE: device.getDeviceType()
			RESIN_HOST_OS_VERSION: device.getOSVersion()
			RESIN_SUPERVISOR_ADDRESS: "http://#{host}:#{listenPort}"
			RESIN_SUPERVISOR_HOST: host
			RESIN_SUPERVISOR_PORT: listenPort
			RESIN_SUPERVISOR_API_KEY: apiSecret
			RESIN_SUPERVISOR_VERSION: version
			RESIN_API_KEY: deviceApiKey
			RESIN: '1'
			USER: 'root'
		if env?
			_.defaults(newEnv, env)
		return Promise.props(newEnv)

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
	options.url = config.gosuperAddress + endpoint
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

# move to container-config.coffee
exports.defaultVolumes = (includeV1Volumes) ->
	volumes = {
		'/data': {}
		'/lib/modules': {}
		'/lib/firmware': {}
		'/host/run/dbus': {}
	}
	if includeV1Volumes
		volumes['/host/var/lib/connman'] = {}
		volumes['/host_run/dbus'] = {}
	return volumes

exports.getDataPath = (identifier) ->
	return config.dataPath + '/' + identifier

exports.defaultBinds = (dataPath, includeV1Binds) ->
	binds = [
		exports.getDataPath(dataPath) + ':/data'
		"/tmp/resin-supervisor/#{dataPath}:/tmp/resin"
		'/lib/modules:/lib/modules'
		'/lib/firmware:/lib/firmware'
		'/run/dbus:/host/run/dbus'
	]
	if includeV1Binds
		binds.push('/run/dbus:/host_run/dbus')
		binds.push('/var/lib/connman:/host/var/lib/connman')
	return binds
