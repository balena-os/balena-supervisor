Promise = require 'bluebird'
_ = require 'lodash'

module.exports = class DeviceConfig
	constructor: ({ @db, @config }) ->

	setTarget: (target) ->
		confToUpdate = {
			targetValues: JSON.stringify(target)
		}
		@db.models('deviceConfig').update(confToUpdate)
	getTarget: ->
		@db.models('deviceConfig').select('targetValues')
		.then ([ devConfig ]) ->
			return JSON.parse(devConfig.targetValues)
	getCurrent: ->
		# Use gosuper to get state of log to display
		# Read config.txt and translate to config vars
		# Get config values
	applyTarget: ->
		# Takes the target value of log to display and calls gosuper to set it
		# Takes the config.txt values and writes them to config.txt
		# Takes the special action env vars and sets the supervisor config
