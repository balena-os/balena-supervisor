Promise = require 'bluebird'
ngrok = Promise.promisifyAll require 'ngrok'
tty = Promise.promisifyAll require 'tty.js'
knex = require './db'

# socat UNIX:/data/host -,raw,echo=0

apps = {}
nextPort = 81
exports.start = (appId) ->
	apps[appId] ?= Promise.rejected()
	return apps[appId] = apps[appId].catch ->
		port = nextPort++
		knex('app').select().where({appId})
		.then ([app]) ->
			if !app?
				throw new Error('App not found')
			tty.createServer
				shell: './src/enterContainer.sh'
				shellArgs: do ->
					i = 0
					return (session) -> [app.containerId, session.id, i++]
			.listenAsync(port, null)
			.then ->
				ngrok.connectAsync(port)

DISCONNECTED = 'Disconnected'
disconnectedErr = (err) -> return err.message is DISCONNECTED
exports.stop = (appId) ->
	if !apps[appId]?
		return Promise.resolve()
	apps[appId] = apps[appId].then (url) ->
		ngrok.disconnectAsync(url)
		.then ->
			throw new Error(DISCONNECTED)
	return apps[appId].catch disconnectedErr, -> # All good!
