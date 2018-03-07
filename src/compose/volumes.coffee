Promise = require 'bluebird'
_ = require 'lodash'
path = require 'path'

logTypes = require '../lib/log-types'
constants = require '../lib/constants'
{ checkInt } = require '../lib/validation'
{ NotFoundError } = require '../lib/errors'
{ defaultLegacyVolume } = require '../lib/migration'
{ safeRename } = require '../lib/fs-utils'

module.exports = class Volumes
	constructor: ({ @docker, @logger }) ->

	format: (volume) ->
		m = volume.Name.match(/^([0-9]+)_(.+)$/)
		appId = checkInt(m[1])
		name = m[2]
		return {
			name: name
			appId: appId
			config: {
				labels: _.omit(volume.Labels, _.keys(constants.defaultVolumeLabels))
				driverOpts: volume.Options
			}
		}

	getAll: =>
		@docker.listVolumes(filters: label: [ 'io.resin.supervised' ])
		.then (response) =>
			volumes = response.Volumes ? []
			Promise.map volumes, (volume) =>
				@docker.getVolume(volume.Name).inspect()
				.then(@format)

	getAllByAppId: (appId) =>
		@getAll()
		.then (volumes) ->
			_.filter(volumes, { appId })

	get: ({ name, appId }) ->
		@docker.getVolume("#{appId}_#{name}").inspect()
		.then(@format)

	# TODO: what config values are relevant/whitelisted?
	# For now we only care about driverOpts and labels
	create: ({ name, config = {}, appId }) =>
		config = _.mapKeys(config, (v, k) -> _.camelCase(k))
		@logger.logSystemEvent(logTypes.createVolume, { volume: { name } })
		labels = _.clone(config.labels) ? {}
		_.assign(labels, constants.defaultVolumeLabels)
		driverOpts = config.driverOpts ? {}
		@get({ name, appId })
		.then (vol) =>
			if !@isEqualConfig(vol.config, config)
				throw new Error("Trying to create volume '#{name}', but a volume with same name and different configuration exists")
		.catch NotFoundError, =>
			@docker.createVolume({
				Name: "#{appId}_#{name}"
				Labels: labels
				DriverOpts: driverOpts
			})
		.tapCatch (err) =>
			@logger.logSystemEvent(logTypes.createVolumeError, { volume: { name }, error: err })

	createFromLegacy: (appId) =>
		name = defaultLegacyVolume()
		@create({ name, appId })
		.call('inspect')
		.then (v) ->
			volumePath = path.join(constants.rootMountPoint, v.Mountpoint)
			legacyPath = path.join(constants.rootMountPoint, constants.dataPath, appId.toString())
			safeRename(legacyPath, volumePath)
		.catch (err) ->
			@logger.logSystemMessage("Warning: could not migrate legacy /data volume: #{err.message}", { error: err }, 'Volume migration error')

	remove: ({ name, appId }) ->
		@logger.logSystemEvent(logTypes.removeVolume, { volume: { name } })
		@docker.getVolume("#{appId}_#{name}").remove()
		.catch (err) =>
			@logger.logSystemEvent(logTypes.removeVolumeError, { volume: { name, appId }, error: err })

	isEqualConfig: (current = {}, target = {}) ->
		current = _.mapKeys(current, (v, k) -> _.camelCase(k))
		target = _.mapKeys(target, (v, k) -> _.camelCase(k))
		currentOpts = current.driverOpts ? {}
		targetOpts = target.driverOpts ? {}
		currentLabels = current.labels ? {}
		targetLabels = target.labels ? {}
		return _.isEqual(currentLabels, targetLabels) and _.isEqual(currentOpts, targetOpts)
