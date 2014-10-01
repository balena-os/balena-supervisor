process.on 'uncaughtException', (e) ->
	console.error('Got unhandled exception', e, e?.stack)

supervisor = require './supervisor-update'

# Make sure the supervisor-update has initialised before we continue, as it will handle restarting to add mounts if
# necessary.
supervisor.initialised.then ->
	# Start the update checks ASAP, as any later point may fail,
	# but at least if we're checking for updates we may be able to update to make them work!
	console.log('Starting periodic check for supervisor updates..')
	setInterval(->
		supervisor.update()
	, 5 * 60 * 1000) # Every 5 mins
	supervisor.update()

	knex = require './db'

	# Wait for the DB schema to be created
	knex.init.then ->
		require('./app')
