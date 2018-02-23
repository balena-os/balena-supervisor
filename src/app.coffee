do ->
	# Make NodeJS RFC 3484 compliant for properly handling IPv6
	# See: https://github.com/nodejs/node/pull/14731
	#      https://github.com/nodejs/node/pull/17793
	dns = require('dns')
	{ lookup } = dns
	dns.lookup = (name, opts, cb) ->
		if typeof cb isnt 'function'
			return lookup(name, { verbatim: true }, opts)
		return lookup(name, Object.assign({ verbatim: true }, opts), cb)

require('log-timestamp')

Supervisor = require './supervisor'

supervisor = new Supervisor()
supervisor.init()
