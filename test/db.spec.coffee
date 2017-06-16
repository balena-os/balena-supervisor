Promise = require 'bluebird'
m = require 'mochainon'
process.env.DATABASE_PATH ?= './database.sqlite'
knex = require '../src/db'
fs = Promise.promisifyAll(require('fs'))

{ expect } = m.chai

describe 'db.coffee', ->
	after ->
		fs.unlinkAsync(process.env.DATABASE_PATH)

	it 'should initialize correctly', ->
		expect(knex.init).to.be.fulfilled

	it 'should have created a database at the appropriate path', ->
		promise = knex.init.then ->
			fs.statAsync(process.env.DATABASE_PATH)
		expect(promise).to.be.fulfilled

	it 'should have created a deviceConfig table with a single default value', ->
		promise = knex.init.then ->
			knex('deviceConfig').select()
		expect(promise).to.eventually.have.lengthOf(1)
		expect(promise).to.eventually.deep.equal([ { values: '{}', targetValues: '{}' } ])