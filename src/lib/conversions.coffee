_ = require 'lodash'

exports.envArrayToObject = (env) ->
	# env is an array of strings that say 'key=value'
	toPair = (keyVal) ->
		m = keyVal.match(/^([^=]+)=(.*)$/)
		return m[1..]
	_.fromPairs(_.map(env, toPair))
