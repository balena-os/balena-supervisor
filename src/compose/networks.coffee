Promise = require 'bluebird'
_ = require 'lodash'

logTypes = require '../lib/log-types'

module.exports = class Networks
	constructor: ({ @docker, @logger }) ->

	format: (network) ->
		return {
			appId: network.Labels['io.resin.appId']
			name: network.Name
			config: {}
		}

	getAll: =>
		@docker.listNetworks(filters: label: [ 'io.resin.supervised' ])
		.then (networks) =>
			Promise.map networks, (network) =>
				@docker.getNetwork(network.Name).inspect()
				.then (net) =>
					@format(net)

	getAllByAppId: (appId) =>
		@getAll()
		.then (networks) ->
			_.filter(networks, (v) -> v.appId == appId)

	get: (name) =>
		@docker.getNetwork(name).inspect()
		.then (network) ->
			return @format(network)

	# TODO: what config values are relevant/whitelisted?
	create: ({ name, config, appId }) =>
		@logger.logSystemEvent(logTypes.createNetwork, { network: { name } })
		@docker.createNetwork({
			Name: name
			Labels: {
				'io.resin.supervised': 'true'
				'io.resin.appId': appId
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

	isEqualConfig: (current, target) ->
		return true
