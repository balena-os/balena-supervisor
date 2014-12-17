Promise = require 'bluebird'
request = Promise.promisifyAll require 'request'

# options: The url to check, or an object of request options.
#	timeout: 10s
#	gzip: true
exports.checkURL = checkURL = (options) ->
	if typeof options is 'string'
		options =
			url: options
	options.timeout ?= 10000
	options.gzip ?= true
	request
	.getAsync(options)
	.spread (response) ->
		return response.statusCode in [ 200, 304 ]
	.catch (e) ->
		return false

# options: The url to monitor, or an object of:
#	interval: The time between each check.
#	checkURL options
# fn(bool connected): The function that will be called each time the state changes.
exports.monitorURL = (options, fn) ->
	interval = options?.interval or 0
	connectivityState = null # Used to prevent multiple messages when disconnected
	_check = ->
		checkURL(options)
		.then (connected) ->
			return if connected == connectivityState
			connectivityState = connected
			fn(connected)
			return # Do not wait on fn if it returns a promise
		.finally ->
			setTimeout(_check, interval)
	_check()
