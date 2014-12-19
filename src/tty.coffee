Promise = require 'bluebird'
ngrok = Promise.promisifyAll require 'ngrok'
tty = Promise.promisifyAll require 'tty.js'
knex = require './db'
TypedError = require 'typed-error'

class DisconnectedError extends TypedError

# socat UNIX:/data/host -,raw,echo=0

apps = {}
nextPort = 81
exports.start = (appId) ->
	apps[appId] ?= Promise.rejected()
	return apps[appId] = apps[appId].catch ->
		port = nextPort++
		knex('app').select().where({appId})
		.then ([ app ]) ->
			if !app?
				throw new Error('App not found')
			tty.createServer
				shell: './src/enterContainer.sh'
				shellArgs: do ->
					i = 0
					return (session) -> [ app.containerId, session.id, i++ ]
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
