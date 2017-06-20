Promise = require 'bluebird'
networkCheck = require 'network-checker'
fs = Promise.promisifyAll require 'fs'
constants = require './constants'
_ = require 'lodash'
url = require 'url'
{ checkTruthy } = require './lib/validation'

blink = require('blinking')(constants.ledFile)

networkPattern =
	blinks: 4
	pause: 1000

pauseConnectivityCheck = false
enableConnectivityCheck = true

# options: An object of net.connect options, with the addition of:
#	timeout: 10s
checkHost = (options) ->
	if !enableConnectivityCheck or pauseConnectivityCheck
		return true
	else
		return networkCheck.checkHost(options)

# Custom monitor that uses checkHost function above.
customMonitor = (options, fn) ->
	networkCheck.monitor(checkHost, options, fn)

# enable: A Boolean to enable/disable the connectivity checks
exports.enableCheck = enableCheck = (enable) ->
	enableConnectivityCheck = enable

# Call back for inotify triggered when the VPN status is changed.
vpnStatusInotifyCallback = ->
	fs.lstatAsync(constants.vpnStatusPath + '/active')
	.then ->
		pauseConnectivityCheck = true
	.catch ->
		pauseConnectivityCheck = false

# Use the following to catch EEXIST errors
EEXIST = (err) -> err.code is 'EEXIST'

exports.connectivityCheck = _.once (apiEndpoint) ->
	parsedUrl = url.parse(apiEndpoint)
	fs.mkdirAsync(constants.vpnStatusPath)
	.catch EEXIST, (err) ->
		console.log('VPN status path exists.')
	.then ->
		fs.watch(constants.vpnStatusPath, vpnStatusInotifyCallback)

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

# Callback function to enable/disable tcp pings
exports.enableConnectivityCheck = (val) ->
	enabled = checkTruthy(val) ? true
	enableCheck(enabled)
	console.log("Connectivity check enabled: #{enabled}")
