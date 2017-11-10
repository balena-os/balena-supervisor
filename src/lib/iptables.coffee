Promise = require 'bluebird'
childProcess = Promise.promisifyAll(require('child_process'))

checkAndAddIptablesRule = (rule) ->
	childProcess.execAsync("iptables -C #{rule}")
	.catch ->
		childProcess.execAsync("iptables -A #{rule}")

checkAndInsertIptablesRule = (rule) ->
	childProcess.execAsync("iptables -C #{rule}")
	.catch ->
		childProcess.execAsync("iptables -I #{rule}")

exports.rejectOnAllInterfacesExcept = (allowedInterfaces, port) ->
	Promise.each allowedInterfaces, (iface) ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{port} -i #{iface} -j ACCEPT")
	.then ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{port} -j REJECT")
		.catch ->
			# On systems without REJECT support, fall back to DROP
			checkAndAddIptablesRule("INPUT -p tcp --dport #{port} -j DROP")

acceptSubnetRule = (allowedSubnet, port) ->
	return "INPUT -p tcp --dport #{port} -s #{allowedSubnet} -j ACCEPT"

exports.addAcceptedSubnet = (allowedSubnet, port) ->
	checkAndInsertIptablesRule(acceptSubnetRule(allowedSubnet, port))

exports.isSubnetAccepted = (allowedSubnet, port) ->
	childProcess.execAsync("iptables -C #{acceptSubnetRule(allowedSubnet, port)}")
