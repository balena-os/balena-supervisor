process.on 'uncaughtException', (e) ->
	console.log('Got unhandled exception', e)

knex = require './db'

# Wait for the DB schema to be created
knex.init.then ->
	require('./app')
