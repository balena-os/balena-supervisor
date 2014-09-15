process.on 'uncaughtException', (e) ->
	console.log('Got unhandled exception', e)

supervisor = require './supervisor-update'

# Make sure the supervisor-update has initialised before we continue, as it will handle restarting to add mounts if
# necessary.
supervisor.initialised.then ->
	knex = require './db'

	# Wait for the DB schema to be created
	knex.init.then ->
		require('./app')
