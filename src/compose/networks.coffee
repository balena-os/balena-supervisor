logTypes = require '../lib/log-types'
{ checkInt } = require '../lib/validation'
{ NotFoundError } = require '../lib/errors'

module.exports = class Networks
	constructor: ({ @docker, @logger }) ->

	# TODO: parse supported config fields
	format: (network) ->
		[ appId, name ] = network.Name.split('_')
		return {
			appId: checkInt(appId)
			name: name
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

	get: ({ name, appId }) =>
		@docker.getNetwork("#{appId}_#{name}").inspect()
		.then(@format)

	# TODO: what config values are relevant/whitelisted?
	create: ({ name, config, appId }) =>
		@logger.logSystemEvent(logTypes.createNetwork, { network: { name } })
		@get({ name, appId })
		.then (net) =>
			if !@isEqualConfig(net.config, config)
				throw new Error("Trying to create network '#{name}', but a network with same name and different configuration exists")
		.catch NotFoundError, =>
			@docker.createNetwork({
				Name: "#{appId}_#{name}"
				Labels: {
					'io.resin.supervised': 'true'
				}
			})
		.catch (err) =>
			@logger.logSystemEvent(logTypes.createNetworkError, { network: { name, appId }, error: err })
			throw err

	remove: ({ name, appId }) =>
		@logger.logSystemEvent(logTypes.removeNetwork, { network: { name, appId } })
		@docker.getNetwork("#{appId}_#{name}").remove()
		.catch (err) =>
			@logger.logSystemEvent(logTypes.removeNetworkError, { network: { name, appId }, error: err })
			throw err

	# TODO: compare supported config fields
	isEqualConfig: (current, target) ->
		return true
