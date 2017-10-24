Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
bodyParser = require 'body-parser'
{
	cleanupTars,
	imageAvailable,
	compareDevices,
	imageForDependentApp,
} = require './utils'
ProxyvisorRouterV1 = require './proxyvisor-router-v1'

class ProxyvisorRouter
	constructor: (@proxyvisor) ->
		{ @config, @logger, @db, @docker } = @proxyvisor
		@_proxyvisorRouterV1 = new ProxyvisorRouterV1(@proxyvisor)
		@router = express.Router()
		@router.use(bodyParser.urlencoded(extended: true))
		@router.use(bodyParser.json())
		@router.use('/v1/dependent', @_proxyvisorRouterV1.router)

module.exports = class Proxyvisor
	constructor: ({ @config, @logger, @db, @docker, @images, @applications }) ->
		@_router = new ProxyvisorRouter(this)
		@router = @_router.router
		@validActions = [ 'updateDependentTargets', 'removeDependentApp' ]

	bindToAPI: (apiBinder) =>
		@apiBinder = apiBinder

	executeStepAction: (step) =>
		Promise.try =>
			actions = {
				updateDependentTargets: =>
					@config.getMany([ 'currentApiKey', 'apiTimeout' ])
					.then ({ currentApiKey, apiTimeout }) =>
						# - take each of the step.devices and update the corresponding dependent device
						# - if update returns 0, then use APIBinder to fetch the device, then store it to the db
						# - delete devices that are not in the step.devices list
						# - update dependentApp with step.app
						Promise.map step.devices, (device) =>
							uuid = device.uuid
							# Only consider one app per dependent device for now
							appId = _(device.apps).keys().head()
							targetCommit = device.apps[appId].commit
							targetEnvironment = JSON.stringify(device.apps[appId].environment)
							targetConfig = JSON.stringify(device.apps[appId].config)
							@db.models('dependentDevice').update({ appId, targetEnvironment, targetConfig, targetCommit, name: device.name, lock_expiry_date: device.lock_expiry_date }).where({ uuid })
							.then (n) =>
								return if n != 0
								# If the device is not in the DB it means it was provisioned externally
								# so we need to fetch it.
								@apiBinder.fetchDevice(uuid, currentApiKey, apiTimeout)
								.then (dev) =>
									deviceForDB = {
										uuid: uuid
										appId: appId
										local_id: dev.local_id
										lock_expiry_date: dev.lock_expiry_date
										device_type: dev.device_type
										deviceId: dev.id
										name: dev.name
										status: dev.status
										logs_channel: dev.logs_channel
										targetCommit
										targetConfig
										targetEnvironment
									}
									@db.models('dependentDevice').insert(deviceForDB)
						.then =>
							@db.models('dependentDevice').where({ appId: step.appId }).whereNotIn('uuid', _.map(step.devices, 'uuid')).del()
						.then =>
							@_normaliseDependentAppForDB(step.app)
						.then (appForDB) =>
							@db.upsertModel('dependentApp', appForDB, { appId: step.appId })
						.then ->
							cleanupTars(step.appId, step.app.commit)

				removeDependentApp: =>
					# find step.app and delete it from the DB
					# find devices with step.appId and delete them from the DB
					@db.transaction (trx) ->
						trx('dependentApp').where({ appId: step.appId }).del()
						.then ->
							trx('dependentDevice').where({ appId: step.appId }).del()
						.then ->
							cleanupTars(step.appId)

			}
			throw new Error("Invalid proxyvisor action #{step.action}") if !actions[step.action]?
			actions[step.action]()

	getRequiredSteps: (availableImages, current, target, stepsInProgress) ->
		steps = []
		Promise.try ->
			targetApps = _.keyBy(target.dependent?.apps ? [], 'appId')
			targetAppIds = _.keys(targetApps)
			currentApps = _.keyBy(current.dependent?.apps ? [], 'appId')
			currentAppIds = _.keys(currentApps)
			allAppIds = _.union(targetAppIds, currentAppIds)

			toBeDownloaded = _.filter targetAppIds, (appId) ->
				return targetApps[appId].commit? and targetApps[appId].image? and !imageAvailable(targetApps[appId].image, availableImages)

			appIdsToCheck = _.filter allAppIds, (appId) ->
				# - if a step is in progress for this appId, ignore
				!_.some(steps.concat(stepsInProgress), (step) -> step.appId == appId)
			_.forEach appIdsToCheck, (appId) ->
				# - if there's current but not target, push a removeDependentApp step
				if !targetApps[appId]?
					steps.push({
						action: 'removeDependentApp'
						appId
					})
					return

				# - if toBeDownloaded includes this app, push a fetch step
				if _.includes(toBeDownloaded, appId)
					steps.push({
						action: 'fetch'
						appId
						image: imageForDependentApp(targetApps[appId])
					})
					return

				devicesForApp = (devices) ->
					_.filter devices, (d) ->
						_.includes(_.keys(d.apps), appId)

				currentDevices = devicesForApp(current.dependent.devices)
				targetDevices = devicesForApp(target.dependent.devices)

				devicesDiffer = compareDevices(currentDevices, targetDevices, appId)
				# - if current doesn't match target, or the devices differ, push an updateDependentTargets step
				if !_.isEqual(currentApps[appId], targetApps[appId]) or devicesDiffer
					steps.push({
						action: 'updateDependentTargets'
						devices: targetDevices
						app: targetApps[appId]
						appId
					})
					return
		.then ->
			return steps

	getCurrentStates: =>
		Promise.join(
			@db.models('dependentApp').select().map(@_normaliseDependentAppFromDB)
			@db.models('dependentDevice').select()
			(apps, devicesFromDB) ->
				devices = _.map devicesFromDB, (device) ->
					dev = {
						uuid: device.uuid
						name: device.name
						lock_expiry_date: device.lock_expiry_date
						apps: {}
					}
					dev.apps[device.appId] = {
						commit: device.commit
						config: JSON.parse(device.config)
						environment: JSON.parse(device.environment)
						targetCommit: device.targetCommit
						targetEnvironment: JSON.parse(device.targetEnvironment)
						targetConfig: JSON.parse(device.targetConfig)
					}
					return dev
				return { apps, devices }
		)

	getTarget: =>
		Promise.props({
			apps: @db.models('dependentAppTarget').select().map(@_normaliseDependentAppFromDB)
			devices: @db.models('dependentDeviceTarget').select().map(@_normaliseDependentDeviceTargetFromDB)
		})

	setTargetInTransaction: (dependent, trx) =>
		Promise.try =>
			if dependent?.apps?
				appsArray = _.map dependent.apps, (app, appId) ->
					appClone = _.clone(app)
					appClone.appId = appId
					return appClone
				Promise.map(appsArray, @_normaliseDependentAppForDB)
				.then (appsForDB) =>
					Promise.map appsForDB, (app) =>
						@db.upsertModel('dependentAppTarget', app, { appId: app.appId }, trx)
					.then ->
						trx('dependentAppTarget').whereNotIn('appId', _.map(appsForDB, 'appId')).del()
		.then =>
			if dependent?.devices?
				devicesArray = _.map dependent.devices, (dev, uuid) ->
					devClone = _.clone(dev)
					devClone.uuid = uuid
					return devClone
				Promise.map devicesArray, (device) =>
					appId = _.keys(device.apps)[0]
					@_normaliseDependentDeviceTargetForDB(device, dependent.apps[appId]?.commit)
				.then (devicesForDB) =>
					Promise.map devicesForDB, (device) =>
						@db.upsertModel('dependentDeviceTarget', device, { uuid: device.uuid }, trx)
					.then ->
						trx('dependentDeviceTarget').whereNotIn('uuid', _.map(devicesForDB, 'uuid')).del()

	imagesInUse: (current, target) ->
		images = []
		if current.dependent?.apps?
			_.forEach current.dependent.apps, (app) ->
				images.push app.image
		if target.dependent?.apps?
			_.forEach target.dependent.apps, (app) ->
				images.push app.image
		return images

	_normaliseDependentDeviceTargetFromDB: (device) ->
		Promise.try ->
			outDevice = {
				uuid: device.uuid
				name: device.name
				lock_expiry_date: device.lock_expiry_date
				apps: JSON.parse(device.apps)
			}
			return outDevice

	_normaliseDependentDeviceTargetForDB: (device, appCommit) ->
		Promise.try ->
			apps = _.clone(device.apps ? {})
			_.forEach apps, (app) ->
				app.commit ?= appCommit
				app.config ?= {}
				app.environment ?= {}
			apps = JSON.stringify(apps)
			outDevice = {
				uuid: device.uuid
				name: device.name
				lock_expiry_date: device.lock_expiry_date
				apps
			}
			return outDevice

	_normaliseDependentAppFromDB: (app) ->
		Promise.try ->
			outApp = {
				appId: app.appId
				name: app.name
				commit: app.commit
				releaseId: app.releaseId
				image: app.image
				parentApp: app.parentApp
			}
			return outApp

	_normaliseDependentAppForDB: (app) =>
		if app.image?
			image = @images.normalise(app.image)
		else
			image = null
		dbApp = {
			appId: app.appId
			name: app.name
			commit: app.commit
			releaseId: app.releaseId
			parentApp: app.parentApp
			image: image
		}
		return Promise.props(dbApp)
