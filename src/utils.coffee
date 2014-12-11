Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
config = require './config'
mixpanel = require 'mixpanel'
request = require './request'

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

# Helps in blinking the LED from the given end point.
exports.blink = (ms = 200) ->
	fs.writeFileAsync(config.ledFile, 1)
	.delay(ms)
	.then -> fs.writeFileAsync(config.ledFile, 0)

# Helps in checking connectivity by pseudo-pinging our endpoint.
exports.checkConnectivity = ->
	# We avoid using ICMP as this traffic is sometimes restricted/dropped. Good
	# ol' port 80 HTTP should always be available :-)
	request
	.getAsync
		url: config.heartbeatEndpoint
		timeout: 10000
	.spread (response) ->
		return response.statusCode in [ 200, 304 ]
	.catch ->
		return false

blinkPattern = do ->
	started = false
	interval = null
	timeout = null
	# This function lets us have sensible param orders,
	# and always have a timeout we can cancel.
	delay = (ms, fn) ->
		timeout = setTimeout(fn, ms)
	start = ->
		interval = setInterval(utils.blink, 400)
		delay 2000, ->
			# Clear the blinks after 2 second
			clearInterval(interval)
			delay 2000, ->
				# And then repeat again after another 2 seconds
				start()
	return {
		start: ->
			return false if started
			started = true
			start()
		stop: ->
			return false if not started
			started = false
			clearInterval(interval)
			clearTimeout(timeout)
	}

exports.connectivityCheck = do ->
	connectivityState = true # Used to prevent multiple messages when disconnected
	_check = ->
		utils.checkConnectivity()
		.then (connected) ->
			return if connected == connectivityState
			connectivityState = connected
			if connectivityState
				console.log('Internet Connectivity: OK')
				blinkPattern.stop()
			else
				console.log('Waiting for connectivity...')
				blinkPattern.start()
		.finally ->
			setTimeout(_check, 10 * 1000) # Every 10 seconds perform this check.
	return _.once(_check)
