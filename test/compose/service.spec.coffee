{ expect } = require 'chai'
ComposeService = require '../../src/compose/service'

describe 'compose/service.cofee', ->
	describe 'parseMemoryNumber()', ->
		makeComposeServiceWithLimit = (memLimit) ->
			new ComposeService(
				appId: 123456
				serviceId: 123456
				serviceName: 'foobar'
				memLimit: memLimit
			)

		it 'should correctly parse memory number strings without a unit', ->
			expect(makeComposeServiceWithLimit('64').memLimit).to.equal(64)

		it 'should correctly apply the default value', ->
			expect(makeComposeServiceWithLimit(undefined).memLimit).to.equal(0)

		it 'should correctly support parsing numbers as memory limits', ->
			expect(makeComposeServiceWithLimit(64).memLimit).to.equal(64)

		it 'should correctly parse memory number strings that use a byte unit', ->
			expect(makeComposeServiceWithLimit('64b').memLimit).to.equal(64)
			expect(makeComposeServiceWithLimit('64B').memLimit).to.equal(64)

		it 'should correctly parse memory number strings that use a kilobyte unit', ->
			expect(makeComposeServiceWithLimit('64k').memLimit).to.equal(65536)
			expect(makeComposeServiceWithLimit('64K').memLimit).to.equal(65536)

			expect(makeComposeServiceWithLimit('64kb').memLimit).to.equal(65536)
			expect(makeComposeServiceWithLimit('64Kb').memLimit).to.equal(65536)

		it 'should correctly parse memory number strings that use a megabyte unit', ->
			expect(makeComposeServiceWithLimit('64m').memLimit).to.equal(67108864)
			expect(makeComposeServiceWithLimit('64M').memLimit).to.equal(67108864)

			expect(makeComposeServiceWithLimit('64mb').memLimit).to.equal(67108864)
			expect(makeComposeServiceWithLimit('64Mb').memLimit).to.equal(67108864)

		it 'should correctly parse memory number strings that use a gigabyte unit', ->
			expect(makeComposeServiceWithLimit('64g').memLimit).to.equal(68719476736)
			expect(makeComposeServiceWithLimit('64G').memLimit).to.equal(68719476736)

			expect(makeComposeServiceWithLimit('64gb').memLimit).to.equal(68719476736)
			expect(makeComposeServiceWithLimit('64Gb').memLimit).to.equal(68719476736)

