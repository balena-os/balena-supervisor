Promise = require 'bluebird'
_ = require 'lodash'
logTypes = require './lib/log-types'
containerConfig = require './lib/container-config'

module.exports = class Containers
	constructor: ({ @docker, @logger, @deviceState }) ->

	kill: (containerId, app = {}, { removeContainer = true } = {}) =>
		@logger.logSystemEvent(logTypes.stopApp, app)
		@deviceState.reportCurrent(status: 'Stopping')
		container = @docker.getContainer(containerId)
		container.stop(t: 10)
		.then =>
			container.remove(v: true) if removeContainer
			return
		# Bluebird throws OperationalError for errors resulting in the normal execution of a promisified function.
		.catch Promise.OperationalError, (err) =>
			# Get the statusCode from the original cause and make sure statusCode its definitely a string for comparison
			# reasons.
			statusCode = '' + err.statusCode
			# 304 means the container was already stopped - so we can just remove it
			if statusCode is '304'
				@logger.logSystemEvent(logTypes.stopAppNoop, app)
				if removeContainer
					return container.remove(v: true)
				return
			# 404 means the container doesn't exist, precisely what we want! :D
			if statusCode is '404'
				@logger.logSystemEvent(logTypes.stopRemoveAppNoop, app)
				return
			throw err
		.tap =>
			@logger.logSystemEvent(logTypes.stopAppSuccess, app)
		.catch (err) =>
			@logger.logSystemEvent(logTypes.stopAppError, app, err)
			throw err

	create: (app) =>
		@get(app)
		.then (container) =>
			return container if container?
			@config.get('isResinOSv1')
			.then (isV1) =>
				volumes = containerConfig.defaultVolumes(isV1)
				binds = containerConfig.defaultBinds(app.appId, isV1)
				Promise.try =>
					env = app.environment
					conf = app.config
					@docker.getImage(app.image).inspect()
					.then (imageInfo) =>
						@logger.logSystemEvent(logTypes.installApp, app)
						@deviceState.reportCurrent(status: 'Installing')

						ports = {}
						portBindings = {}
						if portList?
							portList.forEach (port) ->
								ports[port + '/tcp'] = {}
								portBindings[port + '/tcp'] = [ HostPort: port ]

						if imageInfo?.Config?.Cmd
							cmd = imageInfo.Config.Cmd
						else
							cmd = [ '/bin/bash', '-c', '/start' ]

						restartPolicy = createRestartPolicy({ name: conf['RESIN_APP_RESTART_POLICY'], maximumRetryCount: conf['RESIN_APP_RESTART_RETRIES'] })
						shouldMountKmod(app.image)
						.then (shouldMount) =>
							binds.push('/bin/kmod:/bin/kmod:ro') if shouldMount
							@docker.createContainer(
								Image: app.image
								Cmd: cmd
								Tty: true
								Volumes: volumes
								Env: _.map env, (v, k) -> k + '=' + v
								ExposedPorts: ports
								HostConfig:
									Privileged: true
									NetworkMode: 'host'
									PortBindings: portBindings
									Binds: binds
									RestartPolicy: restartPolicy
							)
			.tap =>
				@logger.logSystemEvent(logTypes.installAppSuccess, app)
			.catch (err) =>
				@logger.logSystemEvent(logTypes.installAppError, app, err)
				throw err

	start: (app) =>
		alreadyStarted = false
		@create(app)
		.tap (container) =>
			@logger.logSystemEvent(logTypes.startApp, app)
			@deviceState.reportCurrent(status: 'Starting')
			container.start()
			.catch (err) =>
				statusCode = '' + err.statusCode
				# 304 means the container was already started, precisely what we want :)
				if statusCode is '304'
					alreadyStarted = true
					return

				if statusCode is '500' and err.json.trim().match(/exec format error$/)
					# Provide a friendlier error message for "exec format error"
					@config.get('deviceType')
					.then (deviceType) ->
						throw new Error("Application architecture incompatible with #{deviceType}: exec format error")
				else
					# rethrow the same error
					throw err
			.catch (err) ->
				# If starting the container failed, we remove it so that it doesn't litter
				container.remove(v: true)
				.finally =>
					@logger.logSystemEvent(logTypes.startAppError, app, err)
					throw err
			.then =>
				@deviceState.reportCurrent(commit: app.commit)
				@logger.attach(@docker, containerId)
		.tap =>
			if alreadyStarted
				@logger.logSystemEvent(logTypes.startAppNoop, app)
			else
				@logger.logSystemEvent(logTypes.startAppSuccess, app)
		.finally =>
			@deviceState.reportCurrent(status: 'Idle')

	# Gets the running container for an app, if it exists and matches the app's configuration
	get: (app) ->
		@getAll()
		.then (containers) =>
			theContainer = _.filter containers, (container) ->
				labels = container.Config.Labels
	# Gets all existing containers that correspond to apps
	getAll: ->
