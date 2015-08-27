Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
config = require './config'
mixpanel = require 'mixpanel'
networkCheck = require 'network-checker'
blink = require('blinking')(config.ledFile)
url = require 'url'
Inotify = require('inotify').Inotify
inotify = new Inotify()
fs = Promise.promisifyAll require 'fs'

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

# Returns an array of the host's ip address(es) by parsing the host /proc/net/fib_trie
exports.findIpAddrs = ->
	fs.readFileAsync('/mnt/fib_trie', 'utf8')
	.then (fibtrie) ->
		prevLine = ''
		fibtrie.split('\n')
		.map (line) ->
			line = line.trim()

			# We only care about LOCAL routes (not UNICAST or BROADCAST)
			if line.match(/LOCAL$/)
				# Then we make sure the previous line was an ending branch (and hence contains an IP - 127.0.0.0 has
				# BROADCAST and LOCAL entries)
				if prevLine.match(/^\|--/)
					# Then we remove the ending branch bit
					maybeAddr = prevLine.replace(/^\|--/, '').trim()
					# And ignore loopback/docker interfaces.
					# TODO: Docker interface can technically be on another address range if 172.17
					if !maybeAddr.match(/^(127.0.0.1|172.17.)/)
						ipAddr = maybeAddr

			prevLine = line
			return ipAddr
		.filter(Boolean)

networkPattern =
	blinks: 4
	pause: 1000

exports.blink = blink

pauseConnectivityCheck = false
disableConnectivityCheck = false

# options: An object of net.connect options, with the addition of:
#	timeout: 10s
checkHost = (options) ->
	new Promise (resolve, reject) ->
		if disableConnectivityCheck
			resolve()
		else
			if pauseConnectivityCheck
				resolve()
			else
				reject()
	.then ->
		return true
	.catch ->
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
vpnStatusInotifyCallback = (arg) ->
	fs.lstatAsync(config.vpnStatusPath+'/active')
	.then ->
		pauseConnectivityCheck=true
	.catch ->
		pauseConnectivityCheck=false

vpn_status =
        path: config.vpnStatusPath
        watch_for: Inotify.IN_DELETE | Inotify.IN_CREATE
        callback: vpnStatusInotifyCallback

exports.connectivityCheck = _.once ->
	parsedUrl = url.parse(config.apiEndpoint)
	fs.mkdirAsync(vpn_status.path)
	.then ->
		inotify.addWatch(vpn_status)
	.catch (error) ->
		if error.code != 'EEXIST'
			throw error
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
