http = require('http')
socketio = require('socket.io')
ioAuth = require('socketio-auth')
utils = require('../utils')

sessionUid = 0

module.exports.createServer = (options) ->
	options = options ? {}

	createPty = (socket) ->
		shell = options.shell ? 'sh'
		shellArgs = if typeof options.shellArgs is 'function' then options.shellArgs(sessionUid++) else options.shellArgs
		cols = options.cols ? 132
		rows = options.rows ? 24

		term = require('pty.js').fork shell, shellArgs,
			name: 'xterm'
			cols: cols
			rows: rows

		term.on 'data', (data) ->
			socket.emit('data', data)

		term.on 'exit', (code, signal) ->
			console.log('shell exiting with code ', code, ' and signal ', signal)
			socket.emit('term exit', {signal: signal})

		console.log('Created shell with pty master/slave pair (master: %d, pid: %d)', term.fd, term.pid)
		return term

	server = http.createServer()
	io = socketio(server)
	ioAuth io, authenticate: (socket, data, cb) ->
		utils.getOrGenerateSecret('api')
		.then (secret) ->
			if data.token is secret
				cb(null, true)
			else
				cb(new Error('Authentication error'))
		.catch (err) ->
			# Shouldn't happen.
			cb(new Error('Invalid API key in supervisor'))

	io.on 'connect', (socket) ->
		term = createPty(socket)

		socket.on 'data', (data) ->
			term.write(data)

		socket.on 'disconnect', ->
			term.destroy()

	return server
