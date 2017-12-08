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
	# We get IP addresses but ignore:
	# - docker and balena bridges (docker0, docker1, balena0, etc)
	# - legacy rce bridges (rce0, etc)
	# - tun interfaces like the legacy vpn
	# - the resin VPN interface (resin-vpn)
	# - loopback interface (lo)
	# - the bridge for dnsmasq (resin-dns)
	# - the docker network for the supervisor API (supervisor0)
	# - custom docker network bridges (br- + 12 hex characters)
	_.flatten(_.map(_.omitBy(os.networkInterfaces(), (interfaceFields, interfaceName) ->
		/^(balena[0-9]+)|(docker[0-9]+)|(rce[0-9]+)|(tun[0-9]+)|(resin-vpn)|(lo)|(resin-dns)|(supervisor0)|(br-[0-9a-f]{12})$/.test(interfaceName))
	, (validInterfaces) ->
		_.map(_.omitBy(validInterfaces, (a) -> a.family != 'IPv4' ), 'address'))
	)

exports.startIPAddressUpdate = do ->
	_lastIPValues = null
	return (callback, interval) ->
		getAndReportIP = ->
			ips = exports.getIPAddresses()
			if !_.isEmpty(_.xor(ips , _lastIPValues))
				_lastIPValues = ips
				callback(ips)
		setInterval( ->
			getAndReportIP()
		, interval)
		getAndReportIP()
