Promise = require 'bluebird'
logTypes = require '../lib/log-types'
{ checkInt } = require '../lib/validation'
{ NotFoundError, ENOENT } = require '../lib/errors'
constants = require '../lib/constants'
fs = Promise.promisifyAll(require('fs'))

module.exports = class Networks
	constructor: ({ @docker, @logger }) ->

	# TODO: parse supported config fields
	format: (network) ->
		m = network.Name.match(/^([0-9]+)_(.+)$/)
		appId = checkInt(m[1])
		name = m[2]
		return {
			appId: appId
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

	supervisorNetworkReady: =>
		# For mysterious reasons sometimes the balena/docker network exists
		# but the interface does not
		fs.statAsync("/sys/class/net/#{constants.supervisorNetworkInterface}")
		.then =>
			@docker.getNetwork(constants.supervisorNetworkInterface).inspect()
		.then (net) ->
			return net.Options['com.docker.network.bridge.name'] == constants.supervisorNetworkInterface
		.catchReturn(NotFoundError, false)
		.catchReturn(ENOENT, false)

	ensureSupervisorNetwork: =>
		removeIt = =>
			@docker.getNetwork(constants.supervisorNetworkInterface).remove()
			.then =>
				@docker.getNetwork(constants.supervisorNetworkInterface).inspect()
		@docker.getNetwork(constants.supervisorNetworkInterface).inspect()
		.then (net) ->
			if net.Options['com.docker.network.bridge.name'] != constants.supervisorNetworkInterface
				removeIt()
			else
				fs.statAsync("/sys/class/net/#{constants.supervisorNetworkInterface}")
				.catch ENOENT, ->
					removeIt()
		.catch NotFoundError, =>
			console.log('Creating supervisor0 network')
			@docker.createNetwork({
				Name: constants.supervisorNetworkInterface
				Options:
					'com.docker.network.bridge.name': constants.supervisorNetworkInterface
			})

	# TODO: compare supported config fields
	isEqualConfig: (current, target) ->
		return true
