Promise = require 'bluebird'
Knex = require 'knex'

knex = Knex(
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

	knex.schema.hasTable('deviceConfig')
	.then (exists) ->
		if not exists
			knex.schema.createTable 'deviceConfig', (t) ->
				t.json('values')
				t.json('targetValues')
	.then ->
		knex('deviceConfig').select()
		.then (deviceConfigs) ->
			knex('deviceConfig').insert({ values: '{}', targetValues: '{}' }) if deviceConfigs.length == 0

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
				t.json('config')
		else
			Promise.all [
				addColumn('app', 'commit', 'string')
				addColumn('app', 'appId', 'string')
				addColumn('app', 'config', 'json')
			]
			.then ->
				# When updating from older supervisors, config can be null
				knex('app').update({ config: '{}' }).whereNull('config')

	knex.schema.hasTable('dependentApp')
	.then (exists) ->
		if not exists
			knex.schema.createTable 'dependentApp', (t) ->
				t.increments('id').primary()
				t.string('appId')
				t.string('parentAppId')
				t.string('name')
				t.string('commit')
				t.string('imageId')
				t.json('config')
				t.json('environment')
		else
			addColumn('dependentApp', 'environment', 'json')

	knex.schema.hasTable('dependentDevice')
	.then (exists) ->
		if not exists
			knex.schema.createTable 'dependentDevice', (t) ->
				t.increments('id').primary()
				t.string('uuid')
				t.string('appId')
				t.string('localId')
				t.string('device_type')
				t.string('logs_channel')
				t.string('deviceId')
				t.boolean('is_online')
				t.string('name')
				t.string('status')
				t.string('download_progress')
				t.string('is_managed_by')
				t.dateTime('lock_expiry_date')
				t.string('commit')
				t.string('targetCommit')
				t.json('environment')
				t.json('targetEnvironment')
				t.json('config')
				t.json('targetConfig')
				t.boolean('markedForDeletion')
		else
			Promise.all [
				addColumn('dependentDevice', 'markedForDeletion', 'boolean')
				addColumn('dependentDevice', 'localId', 'string')
				addColumn('dependentDevice', 'is_managed_by', 'string')
				addColumn('dependentDevice', 'lock_expiry_date', 'dateTime')
		]
])

module.exports = knex
