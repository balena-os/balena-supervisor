require('mocha')

{ expect } = require './lib/chai-config'

ComposeUtils = require('../src/compose/utils')

describe 'Composition utilities', ->

	it 'Should correctly camel case the configuration', ->
		config =
			networks: [
				'test',
				'test2',
			]

		expect(ComposeUtils.camelCaseConfig(config)).to.deep.equal({
			networks: [
				'test'
				'test2'
			]
		})

