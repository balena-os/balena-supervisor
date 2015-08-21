Promise = require('bluebird')
dbus = require('dbus-native')
execAsync = Promise.promisify(require('child_process').exec)
systemBus = dbus.systemBus()

module.exports = systemd =
	iface: null
	init:  ->
		return new Promise (resolve, reject) ->
			systemBus.getService('org.freedesktop.systemd1')
			.getInterface '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', (err, iface) ->
				return reject(err) if err?
				systemd.iface = iface
				resolve()

	proxyMethod: (method)->
		args = Array.prototype.slice.call(arguments, 1)
		Promise.try ->
			return systemd.init() if !systemd.iface
		.then ->
			new Promise (resolve, reject) ->
				cb = (err) ->
					output = Array.prototype.slice.call(arguments, 1)
					return reject(err) if err?
					resolve(output)
				args.push(cb)
				systemd.iface[method].apply(systemd.iface, args)

	shutdown: ->
		execAsync('sync')
		.then ->
			systemd.proxyMethod('PowerOff')

	reboot: ->
		execAsync('sync')
		.then ->
			systemd.proxyMethod('Reboot')
