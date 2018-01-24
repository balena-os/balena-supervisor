_ = require 'lodash'

exports.envArrayToObject = (env) ->
	# env is an array of strings that say 'key=value'
	toPair = (keyVal) ->
		m = keyVal.match(/^([^=]+)=(.*)$/)
		[ _unused, key, val ] = m
		return [ key, val ]
	_.fromPairs(_.map(env, toPair))
