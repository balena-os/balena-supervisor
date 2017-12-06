Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
JSONStream = require 'JSONStream'
fs = Promise.promisifyAll(require('fs'))

logTypes = require '../lib/log-types'
{ checkInt } = require '../lib/validation'
constants = require '../lib/constants'

Service = require './service'

NotFoundError = (err) ->
	return checkInt(err.statusCode) is 404

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
			@emit('change')
		else if containerId? and @volatileState[containerId]?
			delete @volatileState[containerId]
			@emit('change')

	reportNewStatus: (containerId, service, status) =>
		@reportChange(containerId, _.merge({ status }, _.pick(service, [ 'imageId', 'appId', 'releaseId', 'commit' ])))

	_killContainer: (containerId, service = {}, { removeContainer = true }) =>
		@logger.logSystemEvent(logTypes.stopService, { service })
		if service.imageId?
			@reportNewStatus(containerId, service, 'Stopping')
		containerObj = @docker.getContainer(containerId)
		containerObj.stop(t: 10)
		.then ->
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
		.tap =>
			@logger.logSystemEvent(logTypes.stopServiceSuccess, { service })
		.catch (err) =>
			@logger.logSystemEvent(logTypes.stopServiceError, { service, error: err })
			throw err
		.finally =>
			if service.imageId?
				@reportChange(containerId)

	kill: (service, { removeContainer = true } = {}) =>
		@_killContainer(service.containerId, service, { removeContainer })
		.then ->
			service.running = false
			return service

	getAllByAppId: (appId) =>
		@getAll("io.resin.app_id=#{appId}")

	stopAllByAppId: (appId) =>
		Promise.map @getAllByAppId(appId), (service) =>
			@kill(service, { removeContainer: false })

	create: (service) =>
		mockContainerId = @config.newUniqueKey()
		@get(service)
		.then (existingService) =>
			if existingService?
				return @docker.getContainer(existingService.containerId)
			conf = service.toContainerConfig()
			@logger.logSystemEvent(logTypes.installService, { service })
			@reportNewStatus(mockContainerId, service, 'Installing')
			@docker.createContainer(conf)
			.tap (container) =>
				service.containerId = container.id
				@logger.logSystemEvent(logTypes.installServiceSuccess, { service })
		.catch (err) =>
			@logger.logSystemEvent(logTypes.installServiceError, { service, error: err })
			throw err
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
			.catch (err) =>
				# If starting the container failed, we remove it so that it doesn't litter
				container.remove(v: true)
				.finally =>
					@logger.logSystemEvent(logTypes.startServiceError, { service, error: err })
					throw err
			.then =>
				@logger.attach(@docker, container.id, service.serviceId)
		.tap =>
			if alreadyStarted
				@logger.logSystemEvent(logTypes.startServiceNoop, { service })
			else
				@logger.logSystemEvent(logTypes.startServiceSuccess, { service })
		.then (container) ->
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

	# Returns an array with the container(s) matching a service by appId, commit, image and environment
	get: (service) =>
		@getAll("io.resin.service_id=#{service.serviceId}")
		.filter((currentService) -> currentService.isSameContainer(service))
		.get(0)

	getStatus: =>
		@getAll()
		.then (services) =>
			status = _.clone(@volatileState)
			for service in services
				status[service.containerId] ?= _.pick(service, [ 'appId', 'imageId', 'status', 'releaseId', 'commit' ])
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

	handover: (currentService, targetService) =>
		# We set the running container to not restart so that in case of a poweroff
		# it doesn't come back after boot.
		@prepareForHandover(currentService)
		.then =>
			@start(targetService)
		.then =>
			@waitToKill(currentService, targetService.labels['io.resin.update.handover_timeout'])
		.then =>
			@kill(currentService)

	listenToEvents: =>
		if @listening
			return
		@listening = true
		@docker.getEvents(filters: type: [ 'container' ])
		.then (stream) =>
			stream.on 'error', (err) ->
				console.error('Error on docker events stream:', err, err.stack)
			parser = JSONStream.parse()
			parser.on 'data', (data) =>
				if data?.status in ['die', 'start']
					@getByDockerContainerId(data.id)
					.catchReturn(NotFoundError, null)
					.then (service) =>
						if service?
							if data.status == 'die'
								@logger.logSystemEvent(logTypes.serviceExit, { service })
								@containerHasDied[data.id] = true
							else if data.status == 'start' and @containerHasDied[data.id]
								delete @containerHasDied[data.id]
								@logger.logSystemEvent(logTypes.serviceRestart, { service })
								@logger.attach(@docker, data.id, service.serviceId)
					.catch (err) ->
						console.error('Error on docker event:', err, err.stack)
					return
			new Promise (resolve, reject) ->
				parser
				.on 'error', (err) ->
					console.error('Error on docker events stream', err)
					reject()
				.on 'end', ->
					console.error('Docker events stream ended, restarting listener')
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
			@logger.logSystemEvent(logTypes.startServiceNoop, { service })
			@logger.attach(@docker, service.containerId, service.serviceId)
