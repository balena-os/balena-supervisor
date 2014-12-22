Promise = require 'bluebird'
ngrok = Promise.promisifyAll require 'ngrok'
tty = Promise.promisifyAll require 'tty.js'
TypedError = require 'typed-error'

class DisconnectedError extends TypedError

# socat UNIX:/data/host -,raw,echo=0

apps = {}
nextPort = 81
exports.start = (app) ->
	apps[app.id] ?= Promise.rejected()
	return apps[app.id] = apps[app.id].catch ->
		port = nextPort++
		tty.createServer
			shell: './src/enterContainer.sh'
			shellArgs: do ->
				i = 0
				return (session) -> [ app.containerId, session.id, i++ ]
			static: __dirname + '/static'
		.listenAsync(port, null)
		.then ->
			ngrok.connectAsync(port)

exports.stop = (appId) ->
	if !apps[appId]?
		return Promise.resolve()
	apps[appId] = apps[appId].then (url) ->
		ngrok.disconnectAsync(url)
		.then ->
			# We throw an error so that `.start` will catch and restart the session.
			throw new DisconnectedError()
	return apps[appId].catch DisconnectedError, -> # All good, since we want to disconnect here!
