http = require 'http'
_ = require 'lodash'
Promise = require 'bluebird'
TypedError = require 'typed-error'

# Only load term.js when it is actually needed,
# to reduce memory in the likely case it is never used.
term = null
enableDestroy = null
init = _.once ->
	term = require './term'
	enableDestroy = require 'server-destroy'

portGuard = (port) ->
	Promise.fromNode (cb) ->
		server = http.createServer (req, res) ->
			res.end()
		server.listen port, ->
			cb(null, Promise.promisify(server.close, server))
		server.on('error', cb)

class DisconnectedError extends TypedError

# socat UNIX:/data/host -,raw,echo=0

apps = {}
port = 48485
termPortGuard = portGuard(port)

exports.start = (app) ->
	init()
	apps[app.id] ?= Promise.rejected()
	return apps[app.id] = apps[app.id].catch ->
		termPortGuard.then (releasePort) ->
			releasePort().then ->
				server = term.createServer
					shell: './src/enterContainer.sh'
					shellArgs: do ->
						i = 0
						return (session) -> [ app.containerId, session, i++ ]
				enableDestroy(server)
				termListen = Promise.promisify(server.listen, server)
				termListen(port, null).return(server)

exports.stop = (app) ->
	if !apps[app.id]?
		return Promise.resolve()
	apps[app.id] = apps[app.id].then (server) ->
		destroy = Promise.promisify(server.destroy, server)
		destroy()
		.then ->
			termPortGuard = portGuard(port)
		.then ->
			# We throw an error so that `.start` will catch and restart the session.
			throw new DisconnectedError()
	return apps[app.id].catch DisconnectedError, -> # All good, since we want to disconnect here!
