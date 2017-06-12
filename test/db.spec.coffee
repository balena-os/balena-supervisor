Promise = require 'bluebird'
m = require 'mochainon'

fs = Promise.promisifyAll(require('fs'))

{ expect } = m.chai


knex = require '../src/db'
describe 'db.coffee', ->

	it 'initializes correctly', ->
		expect(knex.init).to.be.fulfilled

	it 'creates a database at the appropriate path', ->
		promise = knex.init.then ->
			fs.statAsync(process.env.DATABASE_PATH)
		expect(promise).to.be.fulfilled

	it 'creates a deviceConfig table with a single default value', ->
		promise = knex.init.then ->
			knex('deviceConfig').select()
		expect(promise).to.eventually.have.lengthOf(1)
		expect(promise).to.eventually.deep.equal([ { values: '{}', targetValues: '{}' } ])
