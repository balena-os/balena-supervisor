Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
os = require 'os'
crypto = require 'crypto'

# Parses the output of /proc/cpuinfo to find the "Serial : 710abf21" line
# or the hostname if there isn't a serial number (when run in dev mode)
# The uuid is the SHA1 hash of that value.
exports.getDeviceUuid = ->
	fs.readFileAsync('/proc/cpuinfo', 'utf8')
	.then (cpuinfo) ->
		serial = cpuinfo
			.split('\n')
			.filter((line) -> line.indexOf('Serial') isnt -1)[0]
			?.split(':')[1]
			.trim() or os.hostname()

		return crypto.createHash('sha1').update(serial, 'utf8').digest('hex')

# Parses package.json and returns resin-supervisor's version
exports.getSupervisorVersion = ->
	fs.readFileAsync '../package.json', 'utf-8'
	.then (data) ->
		obj = JSON.parse data
		return obj.version
