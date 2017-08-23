require('log-timestamp')
process.on 'uncaughtException', (e) ->
	console.error('Got unhandled exception', e, e?.stack)

Supervisor = require './supervisor'

supervisor = new Supervisor()
supervisor.init()
