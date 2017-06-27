require './lib/prepare'
Promise = require 'bluebird'
m = require 'mochainon'

iptables = require '../src/lib/iptables'

childProcess = require('child_process')

{ stub } = m.sinon
{ expect } = m.chai


knex = require '../src/db'
describe 'iptables.coffee', ->

	it 'calls iptables to check if the rules exist', ->
		stub(childProcess, 'execAsync').returns(Promise.resolve())
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(childProcess.execAsync.callCount).to.equal(3)
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -j REJECT')
