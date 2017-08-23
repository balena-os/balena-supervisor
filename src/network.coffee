Promise = require 'bluebird'
_ = require 'lodash'
url = require 'url'
networkCheck = require 'network-checker'
os = require 'os'
fs = Promise.promisifyAll(require('fs'))

constants = require './lib/constants'
{ checkTruthy } = require './lib/validation'
blink = require './lib/blink'

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

exports.startConnectivityCheck = _.once (apiEndpoint, enable) ->
	exports.enableConnectivityCheck(enable)
	if !apiEndpoint?
		console.log('No API endpoint specified, skipping connectivity check')
		return
	parsedUrl = url.parse(apiEndpoint)
	fs.mkdirAsync(constants.vpnStatusPath)
	.catch EEXIST, (err) ->
		console.log('VPN status path exists.')
	.then ->
		fs.watch(constants.vpnStatusPath, vpnStatusInotifyCallback)

	# Manually trigger the call back to detect cases when VPN was switched on before the supervisor starts.
	vpnStatusInotifyCallback() if enable
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

exports.connectivityCheckEnabled = Promise.method ->
	return enableConnectivityCheck

exports.getIPAddresses = ->
	_.flatten(_.map(_.omitBy(os.networkInterfaces(), (interfaceFields, interfaceName) ->
		/(docker[0-9]+)|(rce[0-9]+)|(tun[0-9]+)|(resin-vpn)|(lo)/.test(interfaceName))
	, (validInterfaces) ->
		_.map(_.omitBy(validInterfaces, (a) -> a.family != 'IPv4' ), 'address'))
	)

exports.startIPAddressUpdate = do ->
	_lastIPValues = null
	return (callback, interval) ->
		getAndReportIP = ->
			ips = exports.getIPAddresses()
			if !_.isEmpty(_.difference(ips , _lastIPValues))
				_lastIPValues = ips
				callback(ips)
		setInterval( ->
			getAndReportIP()
		, interval)
		getAndReportIP()
