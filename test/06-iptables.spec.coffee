Promise = require 'bluebird'
_ = require 'lodash'
m = require 'mochainon'

iptables = require '../src/lib/iptables'

childProcess = require('child_process')

{ stub } = m.sinon
{ expect } = m.chai

describe 'iptables', ->
	it 'calls iptables to check if the rules to block a port except for some interfaces exist', ->
		stub(childProcess, 'execAsync').returns(Promise.resolve())
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(childProcess.execAsync.callCount).to.equal(3)
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -j REJECT')
		.then ->
			childProcess.execAsync.restore()

	it "calls iptables to create the rules if they don't exist", ->
		stub(childProcess, 'execAsync').callsFake (cmd) ->
			if _.startsWith(cmd, 'iptables -C')
				Promise.reject()
			else
				Promise.resolve()
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(childProcess.execAsync.callCount).to.equal(6)
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -j REJECT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j REJECT')
		.then ->
			childProcess.execAsync.restore()

	it "falls back to blocking the port with DROP if there's no REJECT support", ->
		stub(childProcess, 'execAsync').callsFake (cmd) ->
			if _.startsWith(cmd, 'iptables -C') or /REJECT$/.test(cmd)
				Promise.reject()
			else
				Promise.resolve()
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(childProcess.execAsync.callCount).to.equal(8)
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -j REJECT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j REJECT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -C INPUT -p tcp --dport 42 -j DROP')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j DROP')
		.then ->
			childProcess.execAsync.restore()