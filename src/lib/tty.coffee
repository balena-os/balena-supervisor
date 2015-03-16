_ = require 'lodash'
Promise = require 'bluebird'
TypedError = require 'typed-error'

# Only load ngrok/tty when they are actually needed,
# to reduce memory in the likely case they are never used.
ngrok = null
tty = null
enableDestroy = null
init = _.once ->
	ngrok = Promise.promisifyAll require 'ngrok'
	tty = Promise.promisifyAll require 'tty.js'
	enableDestroy = require 'server-destroy'

class DisconnectedError extends TypedError

# socat UNIX:/data/host -,raw,echo=0

apps = {}
nextPort = 81
exports.start = (app) ->
	init()
	apps[app.id] ?= Promise.rejected()
	return apps[app.id] = apps[app.id].catch ->
		port = nextPort++
		server = tty.createServer
			shell: './src/enterContainer.sh'
			shellArgs: do ->
				i = 0
				return (session) -> [ app.containerId, session.id, i++ ]
			static: __dirname + '/static'
		enableDestroy(server.server)
		Promise.props
			server: server.listenAsync(port, null).return(server.server)
			url: ngrok.connectAsync(port)

exports.stop = (app) ->
	if !apps[app.id]?
		return Promise.resolve()
	apps[app.id] = apps[app.id].then ({server, url}) ->
		destroy = Promise.promisify(server.destroy, server)
		Promise.join(
			destroy()
			# ngrok must have been loaded already or we wouldn't have a url to disconnect from.
			ngrok.disconnectAsync(url)
			->
				# We throw an error so that `.start` will catch and restart the session.
				throw new DisconnectedError()
		)
	return apps[app.id].catch DisconnectedError, -> # All good, since we want to disconnect here!
