Promise = require 'bluebird'
Knex = require 'knex'

knex = Knex.initialize(
	client: 'sqlite3'
	connection:
		filename: '/data/database.sqlite'
)

addColumn = (table, column, type) ->
	knex.schema.hasColumn(table, column)
	.then (exists) ->
		if not exists
			knex.schema.table table, (t) ->
				t[type](column)

knex.init = Promise.all([
	knex.schema.hasTable('config')
	.then (exists) ->
		if not exists
			knex.schema.createTable 'config', (t) ->
				t.string('key').primary()
				t.string('value')

	knex.schema.hasTable('app')
	.then (exists) ->
		if not exists
			knex.schema.createTable 'app', (t) ->
				t.increments('id').primary()
				t.string('name')
				t.string('containerId')
				t.string('commit')
				t.string('imageId')
				t.string('appId')
				t.boolean('privileged')
				t.json('env')
		else
			Promise.all [
				addColumn('app', 'commit', 'string')
				addColumn('app', 'appId', 'string')
			]

	knex.schema.hasTable('image')
	.then (exists) ->
		if not exists
			knex.schema.createTable 'image', (t) ->
				t.increments('id').primary()
				t.string('repoTag')
	knex.schema.hasTable('container')
	.then (exists) ->
		if not exists
			knex.schema.createTable 'container', (t) ->
				t.increments('id').primary()
				t.string('containerId')

])

module.exports = knex
