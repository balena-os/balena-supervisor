Promise = require 'bluebird'
childProcess = Promise.promisifyAll(require('child_process'))

checkAndAddIptablesRule = (rule) ->
	childProcess.execAsync("iptables -C #{rule}")
	.catch ->
		childProcess.execAsync("iptables -A #{rule}")

exports.rejectOnAllInterfacesExcept = (allowedInterfaces, port) ->
	Promise.each allowedInterfaces, (iface) ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{port} -i #{iface} -j ACCEPT")
	.then ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{port} -j REJECT")
		.catch ->
			# On systems without REJECT support, fall back to DROP
			checkAndAddIptablesRule("INPUT -p tcp --dport #{port} -j DROP")
