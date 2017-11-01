Promise = require 'bluebird'
m = require 'mochainon'
constants = require '../src/lib/constants'
fs = Promise.promisifyAll(require('fs'))
blink = require('../src/lib/blink')

{ expect } = m.chai
describe 'blink', ->
	it 'is a blink function', ->
		expect(blink).to.be.a('function')

	it 'has a pattern property with start and stop functions', ->
		expect(blink.pattern.start).to.be.a('function')
		expect(blink.pattern.stop).to.be.a('function')

	it 'writes to a file that represents the LED, and writes a 0 at the end to turn the LED off', ->
		blink(1)
		.then ->
			fs.readFileAsync(constants.ledFile)
		.then (contents) ->
			expect(contents.toString()).to.equal('0')
