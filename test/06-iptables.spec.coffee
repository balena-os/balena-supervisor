Promise = require 'bluebird'
iptables = require '../src/lib/iptables'

{ stub } = require 'sinon'
{ expect } = require './lib/chai-config'

describe 'iptables', ->
	it 'calls iptables to delete and recreate rules to block a port', ->
		stub(iptables, 'execAsync').returns(Promise.resolve())
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(iptables.execAsync.callCount).to.equal(12)
			expect(iptables.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -j REJECT')
			expect(iptables.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j REJECT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -D INPUT -p tcp --dport 42 -j REJECT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -A INPUT -p tcp --dport 42 -j REJECT')
		.then ->
			iptables.execAsync.restore()

	it "falls back to blocking the port with DROP if there's no REJECT support", ->
		stub(iptables, 'execAsync').callsFake (cmd) ->
			if /REJECT$/.test(cmd)
				Promise.reject(new Error())
			else
				Promise.resolve()
		iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42)
		.then ->
			expect(iptables.execAsync.callCount).to.equal(16)
			expect(iptables.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -j REJECT')
			expect(iptables.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j REJECT')
			expect(iptables.execAsync).to.be.calledWith('iptables -D INPUT -p tcp --dport 42 -j DROP')
			expect(iptables.execAsync).to.be.calledWith('iptables -A INPUT -p tcp --dport 42 -j DROP')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -D INPUT -p tcp --dport 42 -j REJECT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -A INPUT -p tcp --dport 42 -j REJECT')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -D INPUT -p tcp --dport 42 -j DROP')
			expect(iptables.execAsync).to.be.calledWith('ip6tables -A INPUT -p tcp --dport 42 -j DROP')
		.then ->
			iptables.execAsync.restore()
