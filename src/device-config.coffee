Promise = require 'bluebird'
_ = require 'lodash'

module.exports = ({ db, config }) ->
	deviceConfig.setTarget = (target) ->
		confToUpdate = {
			targetValues: JSON.stringify(target)
		}
		db('deviceConfig').update(confToUpdate)

	deviceConfig.getTarget = ->
		knex('deviceConfig').select('targetValues')
		.then ([ devConfig ]) ->
			return JSON.parse(devConfig.targetValues)

	deviceConfig.getCurrent = ->
		# Use gosuper to get state of log to display
		# Read config.txt and translate to config vars
		# Get 

	deviceConfig.applyTarget = ->
		# Takes the target value of log to display and calls gosuper to set it
		# Takes the config.txt values and writes them to config.txt

	return deviceConfig
