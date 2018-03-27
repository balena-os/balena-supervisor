_ = require 'lodash'

exports.envArrayToObject = (env, debug = _.noop) ->
	debug("envArrayToObject: #{JSON.stringify(env, null, 2)}")
	# env is an array of strings that say 'key=value'
	toPair = (keyVal) ->
		m = keyVal.match(/^([^=]+)=(.*)$/)
		if !m?
			console.log("WARNING: Could not correctly parse env var #{keyVal}. " +
				'Please fix this var and recreate the container.')
			return null
		return m[1..]
	_(env).map(toPair).filter(([_, v]) -> v?).fromPairs().value()
