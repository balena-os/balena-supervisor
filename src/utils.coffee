Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
config = require './config'
mixpanel = require 'mixpanel'
request = Promise.promisifyAll require 'request'

# Parses package.json and returns resin-supervisor's version
exports.getSupervisorVersion = ->
	fs.readFileAsync(__dirname + '/../package.json', 'utf-8')
	.then (data) ->
		obj = JSON.parse data
		return obj.version

mixpanelClient = mixpanel.init(config.mixpanelToken)

exports.mixpanelProperties = mixpanelProperties =
	username: require('/boot/config.json').username

exports.mixpanelTrack = (event, properties = {}) ->
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
	.getAsync(config.heartbeatEndpoint)
	.spread (response) ->
		return response.statusCode in [ 200, 304 ]
	.catch ->
		return false
