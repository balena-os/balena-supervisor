logTypes = require '../lib/log-types'
{ checkInt } = require '../lib/validation'

module.exports = class Networks
	constructor: ({ @docker, @logger }) ->

	# TODO: parse supported config fields
	format: (network) ->
		return {
			appId: checkInt(network.Labels['io.resin.appId'])
			name: network.Name
			config: {}
		}

	getAll: =>
		@docker.listNetworks(filters: label: [ 'io.resin.supervised' ])
		.map (network) =>
			@docker.getNetwork(network.Name).inspect()
			.then(@format)

	getAllByAppId: (appId) =>
		@getAll()
		.filter((network) -> network.appId == appId)

	get: (name) =>
		@docker.getNetwork(name).inspect()
		.then(@format)

	# TODO: what config values are relevant/whitelisted?
	create: ({ name, config, appId }) =>
		@logger.logSystemEvent(logTypes.createNetwork, { network: { name } })
		@docker.createNetwork({
			Name: name
			Labels: {
				'io.resin.supervised': 'true'
				'io.resin.appId': appId.toString()
			}
		})
		.catch (err) =>
			@logger.logSystemEvent(logTypes.createNetworkError, { network: { name }, error: err })
			throw err

	remove: ({ name }) =>
		@logger.logSystemEvent(logTypes.removeNetwork, { network: { name } })
		@docker.getNetwork(name).remove()
		.catch (err) =>
			@logger.logSystemEvent(logTypes.removeNetworkError, { network: { name }, error: err })
			throw err

	# TODO: compare supported config fields
	isEqualConfig: (current, target) ->
		return true
