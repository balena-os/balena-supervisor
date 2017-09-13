Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll(require('fs'))
ncp = Promise.promisify(require('ncp').ncp)
rimraf = Promise.promisify(require('rimraf'))
ncp.limit = 16

logTypes = require '../lib/log-types'
migration = require '../lib/migration'
constants = require '../lib/constants'

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
	create: ({ name, config = {}, appId }) =>
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

	createFromLegacy: (appId) =>
		name = migration.defaultLegacyVolume(appId)
		@create({ name, appId })
		.then ->
			volumePath = "#{constants.rootMountPoint}/var/lib/docker/volumes/#{name}/_data"
			legacyPath = "/mnt/root/resin-data/#{appId}"
			fs.lstatAsync(legacyPath)
			.then ->
				ncp(legacyPath, volumePath)
			.then ->
				# Before deleting, we rename so that if there's an unexpected poweroff
				# next time we won't copy a partially deleted folder into the volume
				fs.renameAsync(legacyPath, legacyPath + '-old')
				.then ->
					rimraf(legacyPath + '-old')
			.catch (err) ->
				fs.lstatAsync(legacyPath + '-old')
				.then ->
					rimraf(legacyPath + '-old')
				.catch ->
					throw err
		.catch (err) ->
			console.log("Ignoring legacy data volume migration due to #{err}")

	remove: ({ name }) ->
		@logger.logSystemEvent(logTypes.removeVolume, { volume: { name } })
		@docker.getVolume(name).remove()
		.catch (err) =>
			@logger.logSystemEvent(logTypes.removeVolumeError, { volume: { name }, error: err })

	isEqualConfig: (current, target) ->
		_.isEqual(current.labels, target.labels)
