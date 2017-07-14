Promise = require 'bluebird'
_ = require 'lodash'
dockerUtils = require './lib/docker-utils'
{ keyByAndOmit } = require './lib/app-conversions'

module.exports = class ApplicationManager
	constructor: ({ @logger, @config, @deviceState }) ->
		@docker = dockerUtils.docker
		@containers = new Containers({ @docker, @logger, @deviceState })
		@images = new Images({ @docker, @logger, @deviceState })

	init: =>
		@config.get('containersNormalized')
		.then (containersNormalized) =>
			if containersNormalized != 'true'
				# Containers haven't been normalized (this is an updated supervisor)
				# so we need to stop and remove them
				Promise.map @docker.listContainers(), (container) ->

				.then =>
					@config.set('containersNormalized': 'true')

	getCurrent: =>
		Promise.map @docker.listContainers(), (container) ->
			@docker.getContainer(container)
			return {
				appId: app.appId
				image: app.imageId
				name: app.name
				commit: app.commit
				config: JSON.parse(app.config)
			}
		.then (apps) ->

