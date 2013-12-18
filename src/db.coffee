Knex = require('knex')

knex = Knex.initialize(
	client: 'sqlite3'
	connection:
		filename: '/supervisor/data/database.sqlite'
)

knex.schema.hasTable('config').then((exists) ->
	if not exists
		knex.schema.createTable('config', (t) ->
			t.string('key').primary()
			t.string('value')
		)
)

knex.schema.hasTable('app').then((exists) ->
	if not exists
		knex.schema.createTable('app', (t) ->
			t.increments('id').primary()
			t.string('name')
			t.string('imageId')
			t.string('status')
		)
)

module.exports = knex
