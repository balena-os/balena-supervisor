knex = require './db'

exports.set = (conf) ->
	confToUpdate = {}
	confToUpdate.values = JSON.stringify(conf.values) if conf.values?
	confToUpdate.targetValues = JSON.stringify(conf.targetValues) if conf.targetValues?
	knex('deviceConfig').update(confToUpdate)

exports.get = ->
	knex('deviceConfig').select()
	.then ([ deviceConfig ]) ->
		return {
			values: JSON.parse(deviceConfig.values)
			targetValues: JSON.parse(deviceConfig.targetValues)
		}
