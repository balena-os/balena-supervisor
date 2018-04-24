Promise = require 'bluebird'
logTypes = require '../lib/log-types'
{ checkInt } = require '../lib/validation'
{ NotFoundError, ENOENT } = require '../lib/errors'
constants = require '../lib/constants'
fs = Promise.promisifyAll(require('fs'))

module.exports = class Networks
	constructor: ({ @docker, @logger }) ->

	format: (network) ->
		m = network.Name.match(/^([0-9]+)_(.+)$/)
		appId = checkInt(m[1])
		name = m[2]
		return {
			appId: appId
			name: name
			config: {
				labels: _.omit(network.Labels, [ 'io.resin.supervised' ])
				driver: network.Driver
				driver_opts: network.Options
				enable_ipv6: network.EnableIPv6
				internal: network.internal
				ipam: {
					driver: network.IPAM.Driver
					options: network.IPAM.Options ? {}
					config: _.map network.IPAM.Config, (conf) ->
						out = {
							subnet: conf.Subnet
							gateway: conf.Gateway
						}
						if conf.IPRange
							out.ip_range = conf.IPRange
						if conf.AuxiliaryAddresses
							out.aux_addresses = conf.AuxiliaryAddresses
						return out
				}
			}
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
	create: ({ name, config = {}, appId }) =>
		@logger.logSystemEvent(logTypes.createNetwork, { network: { name } })
		@get({ name, appId })
		.then (net) =>
			if !@isEqualConfig(net.config, config)
				throw new Error("Trying to create network '#{name}', but a network with same name and different configuration exists")
		.catch NotFoundError, =>
			netConf = {
				Name: "#{appId}_#{name}"
				CheckDuplicate: true
				Labels: _.assign({ 'io.resin.supervised': 'true' }, config.labels ? {})
				Internal: config.internal ? false
				
			}

			@docker.createNetwork(netConf)
		.tapCatch (err) =>
			@logger.logSystemEvent(logTypes.createNetworkError, { network: { name, appId }, error: err })

	remove: ({ name, appId }) =>
		@logger.logSystemEvent(logTypes.removeNetwork, { network: { name, appId } })
		@docker.getNetwork("#{appId}_#{name}").remove()
		.tapCatch (err) =>
			@logger.logSystemEvent(logTypes.removeNetworkError, { network: { name, appId }, error: err })

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
				.catch(ENOENT, removeIt)
		.catch NotFoundError, =>
			console.log('Creating supervisor0 network')
			@docker.createNetwork({
				Name: constants.supervisorNetworkInterface
				CheckDuplicate: true
				Options:
					'com.docker.network.bridge.name': constants.supervisorNetworkInterface
			})

	# { driver, driver_opts, enable_ipv6, internal, labels, ipam: { driver, config: [{}], options }}
	isEqualConfig: (current, target) ->
		targetCopy = _.defaults({}, target, {
			driver: 'bridge'
			driver_opts: {}
			enable_ipv6: false
			internal: false
			labels: {}
		})

		basicFields = [ 'driver', 'driver_opts', 'enable_ipv6', 'internal', 'labels' ]
		sameBasicConf = _.isEqual(_.pick(current, basicFields), _.pick(targetCopy, basicFields))

		if _.isEmpty(target.ipam) or !sameBasicConf
			return sameBasicConf

		targetIpamCopy = _.defaults({}, target.ipam, {
			driver: 'default'
			options: {}
		})
		ipamFields = [ 'driver', 'options' ]

		sameIpamConf = _.isEqual(_.pick(current.ipam, ipamFields), _.pick(targetIpamCopy, ipamFields))

		if _.isEmpty(targetIpamCopy.config) or !sameIpamConf
			return sameIpamConf

		# IPAM config is an array of objects - if specified as target, we need to check all elements match
		return _.isEmpty(_.xorWith(current.ipam.config, targetIpamCopy.config, _.isEqual))
