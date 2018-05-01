Promise = require 'bluebird'
iptables = require '../src/lib/iptables'

childProcess = require('child_process')

m = require 'mochainon'
{ stub } = m.sinon
{ expect } = m.chai

describe 'iptables', ->
	it 'calls iptables to delete and recreate rules to block a port', ->
		stub(childProcess, 'execAsync').returns(Promise.resolve())
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(childProcess.execAsync.callCount).to.equal(6)
			expect(childProcess.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -j REJECT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j REJECT')
		.then ->
			childProcess.execAsync.restore()

	it "falls back to blocking the port with DROP if there's no REJECT support", ->
		stub(childProcess, 'execAsync').callsFake (cmd) ->
			if /REJECT$/.test(cmd)
				Promise.reject()
			else
				Promise.resolve()
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(childProcess.execAsync.callCount).to.equal(8)
			expect(childProcess.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -j REJECT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j REJECT')
			expect(childProcess.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -j DROP')
			expect(childProcess.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j DROP')
		.then ->
			childProcess.execAsync.restore()