Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
config = require './config'
knex = require './db'
mixpanel = require 'mixpanel'
networkCheck = require 'network-checker'
blink = require('blinking')(config.ledFile)
url = require 'url'
randomHexString = require './lib/random-hex-string'
request = Promise.promisifyAll require 'request'
logger = require './lib/logger'

utils = exports

# Parses package.json and returns resin-supervisor's version
exports.supervisorVersion = require('../package.json').version

mixpanelClient = mixpanel.init(config.mixpanelToken)

exports.mixpanelProperties = mixpanelProperties =
	username: require('/boot/config.json').username

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

	console.log('Event:', event, JSON.stringify(properties))
	# Mutation is bad, and it should feel bad
	properties = _.assign(_.cloneDeep(properties), mixpanelProperties)

	mixpanelClient.track(event, properties)

networkPattern =
	blinks: 4
	pause: 1000

exports.blink = blink

pauseConnectivityCheck = false
disableConnectivityCheck = false

# options: An object of net.connect options, with the addition of:
#	timeout: 10s
checkHost = (options) ->
	if disableConnectivityCheck or pauseConnectivityCheck
		return true
	else
		return networkCheck.checkHost(options)

# Custom monitor that uses checkHost function above.
customMonitor = (options, fn) ->
	networkCheck.monitor(checkHost, options, fn)

# pause: A Boolean to pause the connectivity checks
exports.pauseCheck = (pause) ->
	pauseConnectivityCheck = pause

# disable: A Boolean to disable the connectivity checks
exports.disableCheck = disableCheck = (disable) ->
	disableConnectivityCheck = disable

# Call back for inotify triggered when the VPN status is changed.
vpnStatusInotifyCallback = ->
	fs.lstatAsync(config.vpnStatusPath + '/active')
	.then ->
		pauseConnectivityCheck = true
	.catch ->
		pauseConnectivityCheck = false

# Use the following to catch EEXIST errors
EEXIST = (err) -> err.code is 'EEXIST'

exports.connectivityCheck = _.once ->
	parsedUrl = url.parse(config.apiEndpoint)
	fs.mkdirAsync(config.vpnStatusPath)
	.catch EEXIST, (err) ->
		console.log('VPN status path exists.')
	.then ->
		fs.watch(config.vpnStatusPath, vpnStatusInotifyCallback)

	# Manually trigger the call back to detect cases when VPN was switched on before the supervisor starts.
	vpnStatusInotifyCallback()
	customMonitor
		host: parsedUrl.hostname
		port: parsedUrl.port ? (if parsedUrl.protocol is 'https:' then 443 else 80)
		interval: 10 * 1000
		(connected) ->
			if connected
				console.log('Internet Connectivity: OK')
				blink.pattern.stop()
			else
				console.log('Waiting for connectivity...')
				blink.pattern.start(networkPattern)


secretPromises = {}
generateSecret = (name) ->
	Promise.try ->
		return config.forceSecret[name] if config.forceSecret[name]?
		return randomHexString.generate()
	.then (newSecret) ->
		secretInDB = { key: "#{name}Secret", value: newSecret }
		knex('config').update(secretInDB).where(key: "#{name}Secret")
		.then (affectedRows) ->
			knex('config').insert(secretInDB) if affectedRows == 0
		.return(newSecret)

exports.newSecret = (name) ->
	secretPromises[name] ?= Promise.resolve()
	secretPromises[name] = secretPromises[name].then ->
		generateSecret(name)

exports.getOrGenerateSecret = (name) ->
	secretPromises[name] ?= knex('config').select('value').where(key: "#{name}Secret").then ([ secret ]) ->
		return secret.value if secret?
		generateSecret(name)
	return secretPromises[name]

exports.getConfig = getConfig = (key) ->
	knex('config').select('value').where({ key })
	.then ([ conf ]) ->
		return conf?.value

exports.extendEnvVars = (env, uuid) ->
	host = '127.0.0.1'
	newEnv =
		RESIN_DEVICE_UUID: uuid
		RESIN_SUPERVISOR_ADDRESS: "http://#{host}:#{config.listenPort}"
		RESIN_SUPERVISOR_HOST: host
		RESIN_SUPERVISOR_PORT: config.listenPort
		RESIN_SUPERVISOR_API_KEY: exports.getOrGenerateSecret('api')
		RESIN_SUPERVISOR_VERSION: exports.supervisorVersion
		RESIN_API_KEY: getConfig('apiKey')
		RESIN: '1'
		USER: 'root'
	if env?
		_.defaults(newEnv, env)
	return Promise.props(newEnv)

# Callback function to enable/disable tcp pings
exports.enableConnectivityCheck = (val) ->
	bool = val is 'false'
	disableCheck(bool)
	console.log("Connectivity check enabled: #{not bool}")

# Callback function to enable/disable logs
exports.resinLogControl = (val) ->
	logger.disableLogPublishing(val == 'false')
	console.log('Logs enabled: ' + val)

# Callback function to enable/disable VPN
exports.vpnControl = (val) ->
	enable = val != 'false'
	request.postAsync(config.gosuperAddress + '/v1/vpncontrol', { json: true, body: Enable: enable })
	.spread (response, body) ->
		if response.statusCode == 202
			console.log('VPN enabled: ' + enable)
		else
			console.log('Error: ' + body + ' response:' + response.statusCode)
