prepare = require './lib/prepare'
Promise = require 'bluebird'
m = require 'mochainon'

fs = Promise.promisifyAll(require('fs'))

Knex = require('knex')

createOldDatabase = (path) ->
	knex = new Knex(
		client: 'sqlite3'
		connection:
			filename: path
		useNullAsDefault: true
	)
	createEmptyTable = (name, fn) ->
		knex.schema.createTable name, (t) ->
			fn(t) if fn?
	createEmptyTable 'app', (t) ->
		t.increments('id').primary()
		t.boolean('privileged')
		t.string('containerId')
	.then ->
		createEmptyTable 'config', (t) ->
			t.string('key')
			t.string('value')
	.then ->
		createEmptyTable 'dependentApp', (t) ->
			t.increments('id').primary()
	.then ->
		createEmptyTable 'dependentDevice', (t) ->
			t.increments('id').primary()
	.then ->
		return knex

{ expect } = m.chai
DB = require('../src/db')
describe 'DB', ->
	before ->
		prepare()
		@db = new DB()

	it 'initializes correctly, reporting a migration is not needed when it is a new database', ->
		expect(@db.init()).to.eventually.equal(false)

	it 'creates a database at the path from an env var', ->
		promise = fs.statAsync(process.env.DATABASE_PATH)
		expect(promise).to.be.fulfilled

	it 'creates a database at the path passed on creation', ->
		db2 = new DB({ databasePath: process.env.DATABASE_PATH_2 })
		promise = db2.init().then( -> fs.statAsync(process.env.DATABASE_PATH_2))
		expect(promise).to.be.fulfilled

	it 'adds new fields and removes old ones in an old database', ->
		databasePath = process.env.DATABASE_PATH_3
		createOldDatabase(databasePath)
		.then (knexForDB) ->
			db = new DB({ databasePath })
			db.init()
			.then (needsMigration) ->
				expect(needsMigration).to.equal(true)
				db.finishMigration()
			.then ->
				Promise.all([
					expect(knexForDB.schema.hasColumn('app', 'appId')).to.eventually.be.true
					expect(knexForDB.schema.hasColumn('app', 'releaseId')).to.eventually.be.true
					expect(knexForDB.schema.hasColumn('app', 'config')).to.eventually.be.false
					expect(knexForDB.schema.hasColumn('app', 'privileged')).to.eventually.be.false
					expect(knexForDB.schema.hasColumn('app', 'containerId')).to.eventually.be.false
					expect(knexForDB.schema.hasColumn('dependentApp', 'environment')).to.eventually.be.true
					expect(knexForDB.schema.hasColumn('dependentDevice', 'markedForDeletion')).to.eventually.be.true
					expect(knexForDB.schema.hasColumn('dependentDevice', 'localId')).to.eventually.be.true
					expect(knexForDB.schema.hasColumn('dependentDevice', 'is_managed_by')).to.eventually.be.true
					expect(knexForDB.schema.hasColumn('dependentDevice', 'lock_expiry_date')).to.eventually.be.true
				])

	it 'creates a deviceConfig table with a single default value', ->
		promise = @db.models('deviceConfig').select()
		Promise.all([
			expect(promise).to.eventually.have.lengthOf(1)
			expect(promise).to.eventually.deep.equal([ { targetValues: '{}' } ])
		])

	it 'allows performing transactions', ->
		@db.transaction (trx) ->
			expect(trx.commit()).to.be.fulfilled

