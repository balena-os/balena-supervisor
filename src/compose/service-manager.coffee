Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
JSONStream = require 'JSONStream'
fs = Promise.promisifyAll(require('fs'))

logTypes = require '../lib/log-types'
{ checkInt } = require '../lib/validation'
constants = require '../lib/constants'

Service = require './service'

{ NotFoundError } = require '../lib/errors'

module.exports = class ServiceManager extends EventEmitter
	constructor: ({ @docker, @logger, @config }) ->
		@containerHasDied = {}
		@listening = false
		# Volatile state of containers, indexed by containerId (or random strings if we don't have a containerId yet)
		@volatileState = {}

	killAllLegacy: =>
		# Containers haven't been normalized (this is an updated supervisor)
		# so we need to stop and remove them
		@docker.getImage(constants.supervisorImage).inspect()
		.then (supervisorImage) =>
			Promise.map @docker.listContainers(all: true), (container) =>
				if container.ImageID != supervisorImage.Id
					@_killContainer(container.Id, { serviceName: 'legacy', image: container.ImageID }, { removeContainer: true })

	reportChange: (containerId, status) ->
		if status?
			@volatileState[containerId] ?= {}
			_.merge(@volatileState[containerId], status)
		else if containerId? and @volatileState[containerId]?
			delete @volatileState[containerId]
		@emit('change')

	reportNewStatus: (containerId, service, status) =>
		@reportChange(containerId, _.merge({ status }, _.pick(service, [ 'imageId', 'appId', 'releaseId', 'commit' ])))

	_killContainer: (containerId, service = {}, { removeContainer = true, wait = false }) =>
		Promise.try =>
			@logger.logSystemEvent(logTypes.stopService, { service })
			if service.imageId?
				@reportNewStatus(containerId, service, 'Stopping')
			containerObj = @docker.getContainer(containerId)
			killPromise = containerObj.stop().then ->
				if removeContainer
					containerObj.remove(v: true)
			.catch (err) =>
				# Get the statusCode from the original cause and make sure statusCode it's definitely a string for comparison
				# reasons.
				statusCode = checkInt(err.statusCode)
				# 304 means the container was already stopped - so we can just remove it
				if statusCode is 304
					@logger.logSystemEvent(logTypes.stopServiceNoop, { service })
					if removeContainer
						return containerObj.remove(v: true)
					return
				# 404 means the container doesn't exist, precisely what we want! :D
				if statusCode is 404
					@logger.logSystemEvent(logTypes.stopRemoveServiceNoop, { service })
					return
				throw err
			.tap =>
				delete @containerHasDied[containerId]
				@logger.logSystemEvent(logTypes.stopServiceSuccess, { service })
			.catch (err) =>
				@logger.logSystemEvent(logTypes.stopServiceError, { service, error: err })
			.finally =>
				if service.imageId?
					@reportChange(containerId)
			if wait
				return killPromise
			return null

	kill: (service, { removeContainer = true, wait = false } = {}) =>
		@_killContainer(service.containerId, service, { removeContainer, wait })

	remove: (service) =>
		@logger.logSystemEvent(logTypes.removeDeadService, { service })
		@get(service)
		.then (existingService) =>
			@docker.getContainer(existingService.containerId).remove(v: true)
		.catchReturn(NotFoundError, null)
		.tapCatch (err) =>
			@logger.logSystemEvent(logTypes.removeDeadServiceError, { service, error: err })

	getAllByAppId: (appId) =>
		@getAll("io.resin.app-id=#{appId}")

	stopAllByAppId: (appId) =>
		Promise.map @getAllByAppId(appId), (service) =>
			@kill(service, { removeContainer: false })

	create: (service) =>
		mockContainerId = @config.newUniqueKey()
		@get(service)
		.then (existingService) =>
			return @docker.getContainer(existingService.containerId)
		.catch NotFoundError, =>

			conf = service.toContainerConfig()
			nets = service.extraNetworksToJoin()

			@config.get('name')
			.then (deviceName) =>
				service.environment['RESIN_DEVICE_NAME_AT_INIT'] = deviceName

				@logger.logSystemEvent(logTypes.installService, { service })
				@reportNewStatus(mockContainerId, service, 'Installing')

				@docker.createContainer(conf)
			.tap (container) =>
				service.containerId = container.id

				Promise.map nets, ({ name, endpointConfig }) =>
					@docker
					.getNetwork(name)
					.connect({ Container: container.id, EndpointConfig: endpointConfig })
			.tap =>
				@logger.logSystemEvent(logTypes.installServiceSuccess, { service })
		.tapCatch (err) =>
			@logger.logSystemEvent(logTypes.installServiceError, { service, error: err })
		.finally =>
			@reportChange(mockContainerId)

	start: (service) =>
		alreadyStarted = false
		containerId = null
		@create(service)
		.tap (container) =>
			containerId = container.id
			@logger.logSystemEvent(logTypes.startService, { service })
			@reportNewStatus(containerId, service, 'Starting')
			container.start()
			.catch (err) =>
				statusCode = checkInt(err.statusCode)
				# 304 means the container was already started, precisely what we want :)
				if statusCode is 304
					alreadyStarted = true
					return

				if statusCode is 500 and err.message?.trim?()?.match(/exec format error$/)
					# Provide a friendlier error message for "exec format error"
					@config.get('deviceType')
					.then (deviceType) ->
						throw new Error("Application architecture incompatible with #{deviceType}: exec format error")
				else
					# rethrow the same error
					throw err
			.tapCatch (err) =>
				# If starting the container failed, we remove it so that it doesn't litter
				container.remove(v: true)
				.catchReturn()
				.then =>
					@logger.logSystemEvent(logTypes.startServiceError, { service, error: err })
			.then =>
				@logger.attach(@docker, container.id, service)
		.tap =>
			if alreadyStarted
				@logger.logSystemEvent(logTypes.startServiceNoop, { service })
			else
				@logger.logSystemEvent(logTypes.startServiceSuccess, { service })
		.tap ->
			service.running = true
		.finally =>
			@reportChange(containerId)

	# Gets all existing containers that correspond to apps
	getAll: (extraLabelFilters = []) =>
		filters = label: [ 'io.resin.supervised' ].concat(extraLabelFilters)
		@docker.listContainers({ all: true, filters })
		.mapSeries (container) =>
			@docker.getContainer(container.Id).inspect()
			.then(Service.fromContainer)
			.then (service) =>
				if @volatileState[service.containerId]?.status?
					service.status = @volatileState[service.containerId].status
				return service
			.catchReturn(NotFoundError, null)
		.filter(_.negate(_.isNil))

	# Returns the first container matching a service definition
	get: (service) =>
		@getAll("io.resin.service-id=#{service.serviceId}")
		.filter((currentService) -> currentService.isSameContainer(service))
		.then (services) ->
			if services.length == 0
				e = new Error('Could not find a container matching this service definition')
				e.statusCode = 404
				throw e
			return services[0]

	getStatus: =>
		@getAll()
		.then (services) =>
			status = _.clone(@volatileState)
			for service in services
				status[service.containerId] ?= _.pick(service, [
					'appId',
					'imageId',
					'status',
					'releaseId',
					'commit',
					'createdAt',
					'serviceName',
				])
			return _.values(status)

	getByDockerContainerId: (containerId) =>
		@docker.getContainer(containerId).inspect()
		.then (container) ->
			if !container.Config.Labels['io.resin.supervised']?
				return null
			return Service.fromContainer(container)

	waitToKill: (service, timeout) ->
		pollInterval = 100
		timeout = checkInt(timeout, positive: true) ? 60000
		deadline = Date.now() + timeout

		killmePath = service.killmeFullPathOnHost()

		wait = ->
			fs.statAsync(killmePath)
			.then ->
				fs.unlinkAsync(killmePath).catch(_.noop)
			.catch (err) ->
				if Date.now() < deadline
					Promise.delay(pollInterval).then(wait)
		wait()

	prepareForHandover: (service) =>
		@get(service)
		.then (svc) =>
			container = @docker.getContainer(svc.containerId)
			container.update(RestartPolicy: {})
			.then ->
				container.rename(name: "old_#{service.serviceName}_#{service.imageId}_#{service.releaseId}")

	updateMetadata: (service, { imageId, releaseId }) =>
		@get(service)
		.then (svc) =>
			@docker.getContainer(svc.containerId).rename(name: "#{service.serviceName}_#{imageId}_#{releaseId}")
		.then =>
			@reportChange()

	handover: (currentService, targetService) =>
		# We set the running container to not restart so that in case of a poweroff
		# it doesn't come back after boot.
		@prepareForHandover(currentService)
		.then =>
			@start(targetService)
		.then =>
			@waitToKill(currentService, targetService.labels['io.resin.update.handover-timeout'])
		.then =>
			@kill(currentService)

	listenToEvents: =>
		if @listening
			return
		@listening = true
		@docker.getEvents(filters: type: [ 'container' ])
		.then (stream) =>
			stream.on 'error', (err) ->
				console.error('Error on docker events stream:', err)
			parser = JSONStream.parse()
			parser.on 'data', (data) =>
				if data?.status in ['die', 'start']
					@getByDockerContainerId(data.id)
					.catchReturn(NotFoundError, null)
					.then (service) =>
						if service?
							if data.status == 'die'
								@emit('change')
								@logger.logSystemEvent(logTypes.serviceExit, { service })
								@containerHasDied[data.id] = true
							else if data.status == 'start' and @containerHasDied[data.id]
								@emit('change')
								delete @containerHasDied[data.id]
								@logger.logSystemEvent(logTypes.serviceRestart, { service })
								@logger.attach(@docker, data.id, service)
					.catch (err) ->
						console.error('Error on docker event:', err, err.stack)
					return
			new Promise (resolve, reject) ->
				parser
				.on 'error', (err) ->
					console.error('Error on docker events stream', err)
					reject(err)
				.on 'end', ->
					resolve()
				stream.pipe(parser)
		.catch (err) ->
			console.error('Error listening to events:', err, err.stack)
		.finally =>
			@listening = false
			setTimeout =>
				@listenToEvents()
			, 1000
		return

	attachToRunning: =>
		@getAll()
		.map (service) =>
			if service.status == 'Running'
				@logger.logSystemEvent(logTypes.startServiceNoop, { service })
				@logger.attach(@docker, service.containerId, service)
