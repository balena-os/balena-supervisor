Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
config = require './config'
knex = require './db'
mixpanel = require 'mixpanel'
networkCheck = require 'network-checker'
blink = require('blinking')(config.ledFile)
url = require 'url'
<<<<<<< HEAD
randomHexString = require './lib/random-hex-string'
=======
request = require 'request'
>>>>>>> Allow control of VPN + TCP check + Pub nub logs with Device Environment variables

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
exports.disableCheck = (disable) ->
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

exports.getOrGenerateApiSecret = do ->
	apiSecretPromise = null
	return ->
		apiSecretPromise ?= Promise.rejected()
		apiSecretPromise = apiSecretPromise.catch ->
			knex('config').select('value').where(key: 'apiSecret')
			.then ([ apiSecret ]) ->
				return apiSecret.value if apiSecret?
				Promise.try ->
					return config.forceApiSecret ? randomHexString.generate()
				.then (newSecret) ->
					knex('config').insert([{ key: 'apiSecret', value: newSecret }])
					.return(newSecret)

exports.extendEnvVars = (env, uuid) ->
	host = '127.0.0.1'
	newEnv =
		RESIN_DEVICE_UUID: uuid
		RESIN_SUPERVISOR_ADDRESS: "http://#{host}:#{config.listenPort}"
		RESIN_SUPERVISOR_HOST: host
		RESIN_SUPERVISOR_PORT: config.listenPort
		RESIN_SUPERVISOR_API_KEY: exports.getOrGenerateApiSecret()
		RESIN: '1'
		USER: 'root'
	if env?
		_.extend(newEnv, env)
	return Promise.props(newEnv)

# Disable VPN - Uses am enable String
exports.VPNControl = (enable) ->
	callback = (error, response, body ) ->
		if !error && response.statusCode == 200
			console.log('VPN Enabled: ' + enable)
		else
			console.log(error)
	request.post(config.gosuperAddress + '/v1/vpncontrol', { json: true, body: Enable: enable }, callback)
