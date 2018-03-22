dbus = require 'dbus-native'
Promise = require 'bluebird'

bus = Promise.promisifyAll(dbus.systemBus())

systemdManagerMethodCall = (method, signature = '', body = []) ->
	bus.invokeAsync({
		path: '/org/freedesktop/systemd1'
		destination: 'org.freedesktop.systemd1'
		interface: 'org.freedesktop.systemd1.Manager'
		member: method
		signature
		body
	})

exports.restartService = (serviceName) ->
	systemdManagerMethodCall('RestartUnit', 'ss', [ "#{serviceName}.service", 'fail' ])

exports.startService = (serviceName) ->
	systemdManagerMethodCall('StartUnit', 'ss', [ "#{serviceName}.service", 'fail' ])

exports.stopService = (serviceName) ->
	systemdManagerMethodCall('StopUnit', 'ss', [ "#{serviceName}.service", 'fail' ])

exports.enableService = (serviceName) ->
	systemdManagerMethodCall('EnableUnitFiles', 'asbb', [ [ "#{serviceName}.service" ], false, false ])

exports.disableService = (serviceName) ->
	systemdManagerMethodCall('DisableUnitFiles', 'asb', [ [ "#{serviceName}.service" ], false ])

exports.reboot = Promise.method ->
	setTimeout( ->
		systemdManagerMethodCall('Reboot')
	, 1000)

exports.shutdown = Promise.method ->
	setTimeout( ->
		systemdManagerMethodCall('PowerOff')
	, 1000)

getUnitProperty = (unitName, property) ->
	systemdManagerMethodCall('GetUnit', 's', [ unitName ])
	.then (unitPath) ->
		bus.invokeAsync({
			path: unitPath
			destination: 'org.freedesktop.systemd1'
			interface: 'org.freedesktop.DBus.Properties'
			member: 'Get'
			signature: 'ss'
			body: [ 'org.freedesktop.systemd1.Unit', property ]
		})
	.get(1).get(0)

exports.serviceActiveState = (serviceName) ->
	getUnitProperty("#{serviceName}.service", 'ActiveState')
