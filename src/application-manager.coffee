Promise = require 'bluebird'
_ = require 'lodash'
constants = require './lib/constants'
Docker = require './lib/docker-utils'
{ keyByAndOmit } = require './lib/app-conversions'
UpdateStrategies = require './lib/update-strategies'

persistentLockPath = (app) ->
	appId = app.appId ? app
	return "#{constants.rootMountPoint}#{constants.dataPath}/#{appId}/resin-updates.lock"

tmpLockPath = (app) ->
	appId = app.appId ? app
	return "#{constants.rootMountPoint}/tmp/resin-supervisor/#{appId}/resin-updates.lock"

killmePath = (app) ->
	appId = app.appId ? app
	return "#{constants.rootMountPoint}#{constants.dataPath}/#{appId}/resin-kill-me"

module.exports = class ApplicationManager
	constructor: ({ @logger, @config, @deviceState }) ->
		process.env.DOCKER_HOST = "unix://#{constants.dockerSocket}"
		@docker = new Docker()
		@containers = new Containers({ @docker, @logger, @deviceState })
		@images = new Images({ @docker, @logger, @deviceState })
		@UpdatesLockedError = class UpdatesLockedError extends TypedError
		@updateStrategies = new UpdateStrategies(this)

	init: =>
		@config.get('containersNormalized')
		.then (containersNormalized) =>
			if containersNormalized != 'true'
				# Containers haven't been normalized (this is an updated supervisor)
				# so we need to stop and remove them
				Promise.map(@docker.listContainers(), (container) ->

				)
				.then =>
					@config.set('containersNormalized': 'true')

	getCurrent: =>
		@containers.getAll()

	lockUpdates: (app, { force = false } = {}) ->
		@config.get('isResinOSv1')
		.then (isV1) =>
			persistentLockName = persistentLockPath(app)
			tmpLockName = tmpLockPath(app)
			@_writeLock(tmpLockName)
			.tap (release) =>
				if isV1
					lockFile.unlockAsync(persistentLockName) if force == true
					lockFile.lockAsync(persistentLockName)
					.catch ENOENT, _.noop
					.catch (err) =>
						release()
						throw new @UpdatesLockedError("Updates are locked: #{err.message}")
			.tap (release) ->
				lockFile.unlockAsync(tmpLockName) if force == true
				lockFile.lockAsync(tmpLockName)
				.catch ENOENT, _.noop
				.catch (err) ->
					Promise.try ->
						lockFile.unlockAsync(persistentLockName) if isV1
					.finally =>
						release()
						throw new @UpdatesLockedError("Updates are locked: #{err.message}")
			.disposer (release) ->
				Promise.try ->
					lockFile.unlockAsync(tmpLockName) if force != true
				.then ->
					lockFile.unlockAsync(persistentLockName) if isV1 and force != true
				.finally ->
					release()