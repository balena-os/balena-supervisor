require './lib/prepare'
Promise = require 'bluebird'
m = require 'mochainon'

fs = Promise.promisifyAll(require('fs'))

{ expect } = m.chai


knex = new require('../src/db')()
describe 'db.coffee', ->
	initialization = null
	before ->
		initialization = knex.init()
	it 'initializes correctly', ->
		expect(initialization).to.be.fulfilled

	it 'creates a database at the path from an env var', ->
		promise = fs.statAsync(process.env.DATABASE_PATH)
		expect(promise).to.be.fulfilled

	it 'creates a database at the path passed on creation', ->
		knex2 = new require('../src/db')({ databasePath: process.env.DATABASE_PATH_2 })
		promise = knex2.init().then( -> fs.statAsync(process.env.DATABASE_PATH_2))
		expect(promise).to.be.fulfilled

	it 'creates a deviceConfig table with a single default value', ->
		promise = knex('deviceConfig').select()
		expect(promise).to.eventually.have.lengthOf(1)
		expect(promise).to.eventually.deep.equal([ { values: '{}', targetValues: '{}' } ])
