Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
{ request } = require '../lib/request'
constants = require '../lib/constants'
bodyParser = require 'body-parser'
{
	cleanupTars,
	formatTargetAsState,
	formatCurrentAsState,
} = require './utils'
ProxyvisorRouterV1 = require './proxyvisor-router-v1'
ProxyvisorRouterV2 = require './proxyvisor-router-v2'

class ProxyvisorRouter
	constructor: (@proxyvisor) ->
		{ @config, @logger, @db, @docker, @reportCurrentState } = @proxyvisor
		@_proxyvisorRouterV1 = new ProxyvisorRouterV1(@proxyvisor)
		@_proxyvisorRouterV2 = new ProxyvisorRouterV2(@proxyvisor)
		@router = express.Router()
		@router.use(bodyParser.urlencoded(extended: true))
		@router.use(bodyParser.json())
		@router.use('/v1', @_proxyvisorRouterV1.router)
		@router.use('/v2', @_proxyvisorRouterV2.router)

module.exports = class Proxyvisor
	constructor: ({ @config, @logger, @db, @docker, @images, @applications, @reportCurrentState }) ->
		@acknowledgedState = {}
		@lastRequestForDevice = {}
		@_router = new ProxyvisorRouter(this)
		@router = @_router.router
		@validActions = [ 'updateDependentTargets', 'sendDependentHooks', 'removeDependentApp' ]

	bindToAPI: (apiBinder) =>
		@apiBinder = apiBinder

	executeStepAction: (step) =>
		Promise.try =>
			actions = {
				updateDependentTargets: =>
					@config.getMany([ 'currentApiKey', 'apiTimeout' ])
					.then ({ currentApiKey, apiTimeout }) =>
						# - take each of the step.devices and update dependentDevice with it (targetCommit, targetEnvironment, targetConfig)
						# - if update returns 0, then use APIBinder to fetch the device, then store it to the db
						# - set markedForDeletion: true for devices that are not in the step.devices list
						# - update dependentApp with step.app
						Promise.map step.devices, (device) =>
							uuid = device.uuid
							# Only consider one app per dependent device for now
							appId = _(device.apps).keys().head()
							targetCommit = device.apps[appId].commit
							targetEnvironment = JSON.stringify(device.apps[appId].environment)
							targetConfig = JSON.stringify(device.apps[appId].config)
							@db.models('dependentDevice').update({ appId, targetEnvironment, targetConfig, targetCommit, name: device.name }).where({ uuid })
							.then (n) =>
								return if n != 0
								# If the device is not in the DB it means it was provisioned externally
								# so we need to fetch it.
								@apiBinder.fetchDevice(uuid, currentApiKey, apiTimeout)
								.then (dev) =>
									deviceForDB = {
										uuid: uuid
										appId: appId
										device_type: dev.device_type
										deviceId: dev.id
										is_online: dev.is_online
										name: dev.name
										status: dev.status
										logs_channel: dev.logs_channel
										targetCommit
										targetConfig
										targetEnvironment
									}
									@db.models('dependentDevice').insert(deviceForDB)
						.then =>
							@db.models('dependentDevice').where({ appId: step.appId }).whereNotIn('uuid', _.map(step.devices, 'uuid')).update({ markedForDeletion: true })
						.then =>
							@normaliseDependentAppForDB(step.app)
						.then (appForDB) =>
							@db.upsertModel('dependentApp', appForDB, { appId: step.appId })
						.then ->
							cleanupTars(step.appId, step.app.commit)

				sendDependentHooks: =>
					Promise.join(
						@config.get('apiTimeout')
						@getHookEndpoint(step.appId)
						(apiTimeout, endpoint) =>
							Promise.mapSeries step.devices, (device) =>
								Promise.try =>
									if @lastRequestForDevice[device.uuid]?
										diff = Date.now() - @lastRequestForDevice[device.uuid]
										if diff < 30000
											Promise.delay(30001 - diff)
								.then =>
									@lastRequestForDevice[device.uuid] = Date.now()
									if device.markedForDeletion
										@sendDeleteHook(device, apiTimeout, endpoint)
									else
										@sendUpdate(device, apiTimeout, endpoint)
					)

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

	getCurrentStates: =>
		Promise.join(
			@db.models('dependentApp').select().map(@normaliseDependentAppFromDB)
			@db.models('dependentDevice').select()
			(apps, devicesFromDB) ->
				devices = _.map devicesFromDB, (device) ->
					dev = {
						uuid: device.uuid
						name: device.name
						markedForDeletion: device.markedForDeletion
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

	normaliseDependentAppForDB: (app) =>
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
			config: JSON.stringify(app.config ? {})
			environment: JSON.stringify(app.environment ? {})
		}
		return Promise.props(dbApp)

	normaliseDependentDeviceTargetForDB: (device, appCommit) ->
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
				apps
			}
			return outDevice

	setTargetInTransaction: (dependent, trx) =>
		appsByAppId = _.keyBy(dependent?.apps ? [], 'appId')
		Promise.try =>
			if dependent?.apps?
				Promise.map(dependent.apps, @normaliseDependentAppForDB)
				.then (appsForDB) =>
					Promise.map appsForDB, (app) =>
						@db.upsertModel('dependentAppTarget', app, { appId: app.appId }, trx)
					.then ->
						trx('dependentAppTarget').whereNotIn('appId', _.map(appsForDB, 'appId')).del()
		.then =>
			if dependent?.devices?
				Promise.map dependent.devices, (device) =>
					appId = _.keys(device.apps)[0]
					@normaliseDependentDeviceTargetForDB(device, appsByAppId[appId]?.commit)
				.then (devicesForDB) =>
					Promise.map devicesForDB, (device) =>
						@db.upsertModel('dependentDeviceTarget', device, { uuid: device.uuid }, trx)
					.then ->
						trx('dependentDeviceTarget').whereNotIn('uuid', _.map(devicesForDB, 'uuid')).del()

	normaliseDependentAppFromDB: (app) ->
		Promise.try ->
			outApp = {
				appId: app.appId
				name: app.name
				commit: app.commit
				releaseId: app.releaseId
				image: app.image
				config: JSON.parse(app.config)
				environment: JSON.parse(app.environment)
				parentApp: app.parentApp
			}
			return outApp

	normaliseDependentDeviceTargetFromDB: (device) ->
		Promise.try ->
			outDevice = {
				uuid: device.uuid
				name: device.name
				apps: JSON.parse(device.apps)
			}
			return outDevice

	normaliseDependentDeviceFromDB: (device) ->
		Promise.try ->
			outDevice = _.clone(device)
			_.forEach [ 'environment', 'config', 'targetEnvironment', 'targetConfig' ], (prop) ->
				outDevice[prop] = JSON.parse(device[prop])
			return outDevice

	getTarget: =>
		Promise.props({
			apps: @db.models('dependentAppTarget').select().map(@normaliseDependentAppFromDB)
			devices: @db.models('dependentDeviceTarget').select().map(@normaliseDependentDeviceTargetFromDB)
		})

	imagesInUse: (current, target) ->
		images = []
		if current.dependent?.apps?
			_.forEach current.dependent.apps, (app) ->
				images.push app.image
		if target.dependent?.apps?
			_.forEach target.dependent.apps, (app) ->
				images.push app.image
		return images

	_imageAvailable: (image, available) ->
		_.some available, (availableImage) ->
			_.includes(availableImage.NormalisedRepoTags, image)

	_getHookStep: (currentDevices, appId) =>
		hookStep = {
			action: 'sendDependentHooks'
			devices: []
			appId
		}
		_.forEach currentDevices, (device) =>
			if device.markedForDeletion
				hookStep.devices.push({
					uuid: device.uuid
					markedForDeletion: true
				})
			else
				targetState = {
					appId
					commit: device.apps[appId].targetCommit
					config: device.apps[appId].targetConfig
					environment: device.apps[appId].targetEnvironment
				}
				currentState = {
					appId
					commit: device.apps[appId].commit
					config: device.apps[appId].config
					environment: device.apps[appId].environment
				}
				if device.apps[appId].targetCommit? and !_.isEqual(targetState, currentState) and !_.isEqual(targetState, @acknowledgedState[device.uuid])
					hookStep.devices.push({
						uuid: device.uuid
						target: targetState
					})
		return hookStep

	_compareDevices: (currentDevices, targetDevices, appId) ->
		currentDeviceTargets = _.map currentDevices, (dev) ->
			return null if dev.markedForDeletion
			devTarget = _.clone(dev)
			delete devTarget.markedForDeletion
			devTarget.apps = {}
			devTarget.apps[appId] = {
				commit: dev.apps[appId].targetCommit
				environment: dev.apps[appId].targetEnvironment
				config: dev.apps[appId].targetConfig
			}
			return devTarget
		currentDeviceTargets = _.filter(currentDeviceTargets, (dev) -> !_.isNull(dev))
		return !_.isEmpty(_.xorWith(currentDeviceTargets, targetDevices, _.isEqual))

	getRequiredSteps: (availableImages, current, target, stepsInProgress) =>
		steps = []
		Promise.try =>
			targetApps = _.keyBy(target.dependent?.apps ? [], 'appId')
			targetAppIds = _.keys(targetApps)
			currentApps = _.keyBy(current.dependent?.apps ? [], 'appId')
			currentAppIds = _.keys(currentApps)
			allAppIds = _.union(targetAppIds, currentAppIds)

			toBeDownloaded = _.filter targetAppIds, (appId) =>
				return targetApps[appId].commit? and targetApps[appId].image? and !@_imageAvailable(targetApps[appId].image, availableImages)

			appIdsToCheck = _.filter allAppIds, (appId) ->
				# - if a step is in progress for this appId, ignore
				!_.some(steps.concat(stepsInProgress), (step) -> step.appId == appId)
			_.forEach appIdsToCheck, (appId) =>
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
						current: null
						target: targetApps[appId]
						options: @applications.fetchOptionsFromAppConfig(targetApps[appId])
					})
					return

				devicesForApp = (devices) ->
					_.filter devices, (d) ->
						_.includes(_.keys(d.apps), appId)

				currentDevices = devicesForApp(current.dependent.devices)
				targetDevices = devicesForApp(target.dependent.devices)

				devicesDiffer = @_compareDevices(currentDevices, targetDevices, appId)
				# - if current doesn't match target, or the devices differ, push an updateDependentTargets step
				if !_.isEqual(currentApps[appId], targetApps[appId]) or devicesDiffer
					steps.push({
						action: 'updateDependentTargets'
						devices: targetDevices
						app: targetApps[appId]
						appId
					})
					return

				# if we got to this point, the current app is up to date and devices have the
				# correct targetCommit, targetEnvironment and targetConfig.
				hookStep = @_getHookStep(currentDevices, appId)
				if !_.isEmpty(hookStep.devices)
					steps.push(hookStep)
		.then ->
			return steps

	getHookEndpoint: (appId) =>
		@db.models('dependentApp').select('parentApp').where({ appId })
		.then ([ { parentApp } ]) =>
			@applications.getTargetApp(parentApp)
		.then (parentApp) =>
			Promise.map parentApp?.services ? [], (service) =>
				@docker.getImageEnv(service.image)
				.then (imageEnv) ->
					return imageEnv.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS
			.then (imageHookAddresses) ->
				for addr in imageHookAddresses
					return addr if addr?
				return parentApp?.config?.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS ?
						"#{constants.proxyvisorHookReceiver}/v1/devices/"

	sendUpdate: (device, timeout, endpoint) =>
		request.putAsync "#{endpoint}#{device.uuid}", {
			json: true
			body: device.target
		}
		.timeout(timeout)
		.spread (response, body) =>
			if response.statusCode == 200
				@acknowledgedState[device.uuid] = device.target
			else
				@acknowledgedState[device.uuid] = null
				throw new Error("Hook returned #{response.statusCode}: #{body}") if response.statusCode != 202
		.catch (err) ->
			return console.error("Error updating device #{device.uuid}", err, err.stack)

	sendDeleteHook: ({ uuid }, timeout, endpoint) =>
		request.delAsync("#{endpoint}#{uuid}")
		.timeout(timeout)
		.spread (response, body) =>
			if response.statusCode == 200
				@db.models('dependentDevice').del().where({ uuid })
			else
				throw new Error("Hook returned #{response.statusCode}: #{body}")
		.catch (err) ->
			return console.error("Error deleting device #{uuid}", err, err.stack)

	sendUpdates: ({ uuid }) =>
		Promise.join(
			@db.models('dependentDevice').where({ uuid }).select()
			@config.get('apiTimeout')
			([ dev ], apiTimeout) =>
				if !dev?
					console.log("Warning, trying to send update to non-existent device #{uuid}")
					return
				@normaliseDependentDeviceFromDB(dev)
				.then (device) =>
					currentState = formatCurrentAsState(device)
					targetState = formatTargetAsState(device)
					@getHookEndpoint(device.appId)
					.then (endpoint) =>
						if device.markedForDeletion
							@sendDeleteHook(device, apiTimeout, endpoint)
						else if device.targetCommit? and !_.isEqual(targetState, currentState) and !_.isEqual(targetState, @acknowledgedState[device.uuid])
							@sendUpdate(device, targetState, apiTimeout, endpoint)
		)
