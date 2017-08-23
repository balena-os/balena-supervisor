Promise = require 'bluebird'
_ = require 'lodash'

logTypes = require '../lib/log-types'

module.exports = class Volumes
	constructor: ({ @docker, @logger }) ->

	format: (volume) ->
		appId = volume.Labels['io.resin.app_id']
		return {
			name: volume.Name
			appId
			config: {
				labels: _.omit(volume.Labels, _.keys(@defaultLabels(appId)))
			}
		}

	getAll: =>
		@docker.listVolumes(filters: label: [ 'io.resin.supervised' ])
		.then (response) =>
			volumes = response.Volumes ? []
			Promise.map volumes, (volume) =>
				@docker.getVolume(volume.Name).inspect()
				.then (vol) =>
					@format(vol)

	getAllByAppId: (appId) =>
		@getAll()
		.then (volumes) ->
			_.filter(volumes, (v) -> v.appId == appId)

	get: (name) ->
		@docker.getVolume(name).inspect()
		.then (volume) ->
			return @format(volume)

	defaultLabels: (appId) ->
		return {
			'io.resin.supervised': 'true'
			'io.resin.app_id': appId
		}

	# TODO: what config values are relevant/whitelisted?
	create: ({ name, config, appId }) =>
		@logger.logSystemEvent(logTypes.createVolume, { volume: { name } })
		labels = _.clone(config.labels) ? {}
		_.assign(labels, @defaultLabels(appId))
		@docker.createVolume({
			Name: name
			Labels: labels
		})
		.catch (err) =>
			@logger.logSystemEvent(logTypes.createVolumeError, { volume: { name }, error: err })
			throw err

	remove: ({ name }) ->
		@logger.logSystemEvent(logTypes.removeVolume, { volume: { name } })
		@docker.getVolume(name).remove()
		.catch (err) =>
			@logger.logSystemEvent(logTypes.removeVolumeError, { volume: { name }, error: err })

	isEqualConfig: (current, target) ->
		_.isEqual(current.labels, target.labels)
