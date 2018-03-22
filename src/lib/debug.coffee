debugLib = require 'debug'
{ checkTruthy } = require './validation'

module.exports = (name, config) ->
	# TODO: So eventually we want levels, and not just a boolean flag,
	# but for now it can be all or nothing
	debug = debugLib("Resin-supervisor:#{name}")

	config.get('debugMode').then (mode) ->
		debug.enabled = checkTruthy(mode)

	config.on 'change', (conf) ->
		debug.enabled = checkTruthy(conf.debugMode)

	return debug

