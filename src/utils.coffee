Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
config = require './config'
mixpanel = require 'mixpanel'
request = require './request'
networkCheck = require './lib/network-check'
blink = require('blinker')(config.ledFile)

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
exports.connectivityCheck = _.once ->
	networkCheck.monitorURL 
		url: config.heartbeatEndpoint
		interval: 10 * 1000
		(connected) ->
			if connected
				console.log('Internet Connectivity: OK')
				blink.pattern.stop()
			else
				console.log('Waiting for connectivity...')
				blink.pattern.start(networkPattern)
