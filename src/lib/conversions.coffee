_ = require 'lodash'

exports.envArrayToObject = (env) ->
	# env is an array of strings that say 'key=value'
	_(env)
	.invokeMap('split', '=')
	.fromPairs()
	.value()
