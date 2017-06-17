Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
config = require './config'
knex = require './db'
mixpanel = require 'mixpanel'
blink = require('blinking')(config.ledFile)
{ request } = require './request'
logger = require './lib/logger'
TypedError = require 'typed-error'
execAsync = Promise.promisify(require('child_process').exec)
device = require './device'
{ checkTruthy } = require './lib/validation'

exports.supervisorVersion = require('./lib/supervisor-version')

configJson = require('/boot/config.json')
if Boolean(config.apiEndpoint) and !Boolean(configJson.supervisorOfflineMode)
	mixpanelClient = mixpanel.init(config.mixpanelToken)
else
	mixpanelClient = { track: _.noop }

exports.mixpanelProperties = mixpanelProperties =
	username: configJson.username

exports.mixpanelTrack = (event, properties = {}) ->
	# Allow passing in an error directly and having it assigned to the error property.
	if properties instanceof Error
		properties = error: properties

	# If the properties has an error argument that is an Error object then it treats it nicely,
	# rather than letting it become `{}`
	if properties.error instanceof Error
		properties.error =
			message: properties.error.message
			stack: properties.error.stack

	properties = _.cloneDeep(properties)

	# Don't log private env vars (e.g. api keys)
	if properties?.app?.env?
		try
			{ env } = properties.app
			env = JSON.parse(env) if _.isString(env)
			safeEnv = _.omit(env, config.privateAppEnvVars)
			properties.app.env = JSON.stringify(safeEnv)
		catch
			properties.app.env = 'Fully hidden due to error in selective hiding'

	console.log('Event:', event, JSON.stringify(properties))
	# Mutation is bad, and it should feel bad
	properties = _.assign(properties, mixpanelProperties)

	mixpanelClient.track(event, properties)

exports.blink = blink

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

# Callback function to enable/disable logs
exports.resinLogControl = (val) ->
	logEnabled = checkTruthy(val) ? true
	logger.disableLogPublishing(!logEnabled)
	console.log('Logs enabled: ' + val)

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

exports.validComposeOptions = [
	'command'
	'entrypoint'
	'environment'
	'expose'
	'image'
	'labels'
	'links'
	'net'
	'network_mode'
	'ports'
	'privileged'
	'restart'
	'stop_signal'
	'user'
	'volumes' # Will be overwritten with the default binds
	'working_dir'
]

exports.validContainerOptions = [
	'Hostname'
	'User'
	'Env'
	'Labels'
	'Cmd'
	'Entrypoint'
	'Image'
	'Volumes'
	'WorkingDir'
	'ExposedPorts'
	'HostConfig'
	'Name'
]

exports.validHostConfigOptions = [
	'Binds' # Will be overwritten with the default binds
	'Links'
	'PortBindings'
	'Privileged'
	'RestartPolicy'
	'NetworkMode'
]

exports.validateKeys = (options, validSet) ->
	Promise.try ->
		return if !options?
		invalidKeys = _.keys(_.omit(options, validSet))
		throw new Error("Using #{invalidKeys.join(', ')} is not allowed.") if !_.isEmpty(invalidKeys)

checkAndAddIptablesRule = (rule) ->
	execAsync("iptables -C #{rule}")
	.catch ->
		execAsync("iptables -A #{rule}")

exports.createIpTablesRules = ->
	allowedInterfaces = ['resin-vpn', 'tun0', 'docker0', 'lo']
	Promise.each allowedInterfaces, (iface) ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{config.listenPort} -i #{iface} -j ACCEPT")
	.then ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{config.listenPort} -j REJECT")
		.catch ->
			# On systems without REJECT support, fall back to DROP
			checkAndAddIptablesRule("INPUT -p tcp --dport #{config.listenPort} -j DROP")
