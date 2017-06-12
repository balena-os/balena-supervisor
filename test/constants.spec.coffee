Promise = require 'bluebird'
m = require 'mochainon'
constants = require '../src/constants'

{ expect } = m.chai

describe 'constants.coffee', ->

	it 'has the correct configJsonPathOnHost', ->
		expect(constants.configJsonPathOnHost).to.equal('/config.json')
	it 'has the correct rootMountPoint', ->
		expect(constants.rootMountPoint).to.equal('./test/data')