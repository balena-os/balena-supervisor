_ = require 'lodash'
Promise = require 'bluebird'
TypedError = require 'typed-error'

# Only load tty when it is actually needed,
# to reduce memory in the likely case it is never used.
tty = null
enableDestroy = null
init = _.once ->
	tty = Promise.promisifyAll require 'tty.js'
	enableDestroy = require 'server-destroy'

class DisconnectedError extends TypedError

# socat UNIX:/data/host -,raw,echo=0

apps = {}
port = 48485
exports.start = (app) ->
	init()
	apps[app.id] ?= Promise.rejected()
	return apps[app.id] = apps[app.id].catch ->
		server = tty.createServer
			shell: './src/enterContainer.sh'
			shellArgs: do ->
				i = 0
				return (session) -> [ app.containerId, session.id, i++ ]
			static: __dirname + '/static'
		enableDestroy(server.server)
		server.listenAsync(port, null).return(server.server)

exports.stop = (app) ->
	if !apps[app.id]?
		return Promise.resolve()
	apps[app.id] = apps[app.id].then (server) ->
		destroy = Promise.promisify(server.destroy, server)
		Promise.join(
			destroy()
			->
				# We throw an error so that `.start` will catch and restart the session.
				throw new DisconnectedError()
		)
	return apps[app.id].catch DisconnectedError, -> # All good, since we want to disconnect here!
