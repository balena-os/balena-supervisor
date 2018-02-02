Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
{ request } = require './lib/request'
constants = require './lib/constants'
{ checkInt } = require './lib/validation'
path = require 'path'
mkdirp = Promise.promisify(require('mkdirp'))
bodyParser = require 'body-parser'
execAsync = Promise.promisify(require('child_process').exec)
url = require 'url'

isDefined = _.negate(_.isUndefined)

parseDeviceFields = (device) ->
	device.id = parseInt(device.deviceId)
	device.appId = parseInt(device.appId)
	device.config = JSON.parse(device.config ? '{}')
	device.environment = JSON.parse(device.environment ? '{}')
	device.targetConfig = JSON.parse(device.targetConfig ? '{}')
	device.targetEnvironment = JSON.parse(device.targetEnvironment ? '{}')
	return _.omit(device, 'markedForDeletion', 'logs_channel')

# TODO move to lib/validation
validStringOrUndefined = (s) ->
	_.isUndefined(s) or !_.isEmpty(s)
validObjectOrUndefined = (o) ->
	_.isUndefined(o) or _.isObject(o)

tarDirectory = (appId) ->
	return "/data/dependent-assets/#{appId}"

tarFilename = (appId, commit) ->
	return "#{appId}-#{commit}.tar"

tarPath = (appId, commit) ->
	return "#{tarDirectory(appId)}/#{tarFilename(appId, commit)}"

getTarArchive = (source, destination) ->
	fs.lstatAsync(destination)
	.catch ->
		mkdirp(path.dirname(destination))
		.then ->
			execAsync("tar -cvf '#{destination}' *", cwd: source)

cleanupTars = (appId, commit) ->
	if commit?
		fileToKeep = tarFilename(appId, commit)
	else
		fileToKeep = null
	dir = tarDirectory(appId)
	fs.readdirAsync(dir)
	.catchReturn([])
	.then (files) ->
		if fileToKeep?
			files = _.filter files, (file) ->
				return file isnt fileToKeep
		Promise.map files, (file) ->
			if !fileToKeep? or (file isnt fileToKeep)
				fs.unlinkAsync(path.join(dir, file))

formatTargetAsState = (device) ->
	return {
		appId: parseInt(device.appId)
		commit: device.targetCommit
		environment: device.targetEnvironment
		config: device.targetConfig
	}

formatCurrentAsState = (device) ->
	return {
		appId: parseInt(device.appId)
		commit: device.commit
		environment: device.environment
		config: device.config
	}

class ProxyvisorRouter
	constructor: (@proxyvisor) ->
		{ @config, @logger, @db, @docker } = @proxyvisor
		@router = express.Router()
		@router.use(bodyParser.urlencoded(extended: true))
		@router.use(bodyParser.json())
		@router.get '/v1/devices', (req, res) =>
			@db.models('dependentDevice').select()
			.map(parseDeviceFields)
			.then (devices) ->
				res.json(devices)
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.post '/v1/devices', (req, res) =>
			{ appId, device_type } = req.body

			if !appId? or _.isNaN(parseInt(appId)) or parseInt(appId) <= 0
				res.status(400).send('appId must be a positive integer')
				return
			device_type = 'generic' if !device_type?
			d =
				belongs_to__application: req.body.appId
				device_type: device_type
			@proxyvisor.apiBinder.provisionDependentDevice(d)
			.then (dev) =>
				# If the response has id: null then something was wrong in the request
				# but we don't know precisely what.
				if !dev.id?
					res.status(400).send('Provisioning failed, invalid appId or credentials')
					return
				deviceForDB = {
					uuid: dev.uuid
					appId
					device_type: dev.device_type
					deviceId: dev.id
					name: dev.name
					status: dev.status
					logs_channel: dev.logs_channel
				}
				@db.models('dependentDevice').insert(deviceForDB)
				.then ->
					res.status(201).send(dev)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.get '/v1/devices/:uuid', (req, res) =>
			uuid = req.params.uuid
			@db.models('dependentDevice').select().where({ uuid })
			.then ([ device ]) ->
				return res.status(404).send('Device not found') if !device?
				return res.status(410).send('Device deleted') if device.markedForDeletion
				res.json(parseDeviceFields(device))
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.post '/v1/devices/:uuid/logs', (req, res) =>
			uuid = req.params.uuid
			m = {
				message: req.body.message
				timestamp: req.body.timestamp or Date.now()
			}
			m.isSystem = req.body.isSystem if req.body.isSystem?

			@db.models('dependentDevice').select().where({ uuid })
			.then ([ device ]) =>
				return res.status(404).send('Device not found') if !device?
				return res.status(410).send('Device deleted') if device.markedForDeletion
				@logger.log(m, { channel: "device-#{device.logs_channel}-logs" })
				res.status(202).send('OK')
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.put '/v1/devices/:uuid', (req, res) =>
			uuid = req.params.uuid
			{ status, is_online, commit, releaseId, environment, config } = req.body
			validateDeviceFields = ->
				if isDefined(is_online) and !_.isBoolean(is_online)
					return 'is_online must be a boolean'
				if !validStringOrUndefined(status)
					return 'status must be a non-empty string'
				if !validStringOrUndefined(commit)
					return 'commit must be a non-empty string'
				if !validStringOrUndefined(releaseId)
					return 'commit must be a non-empty string'
				if !validObjectOrUndefined(environment)
					return 'environment must be an object'
				if !validObjectOrUndefined(config)
					return 'config must be an object'
				return null
			requestError = validateDeviceFields()
			if requestError?
				res.status(400).send(requestError)
				return

			environment = JSON.stringify(environment) if isDefined(environment)
			config = JSON.stringify(config) if isDefined(config)

			fieldsToUpdateOnDB = _.pickBy({ status, is_online, commit, releaseId, config, environment }, isDefined)
			fieldsToUpdateOnAPI = _.pick(fieldsToUpdateOnDB, 'status', 'is_online', 'commit', 'releaseId')

			if _.isEmpty(fieldsToUpdateOnDB)
				res.status(400).send('At least one device attribute must be updated')
				return

			@db.models('dependentDevice').select().where({ uuid })
			.then ([ device ]) =>
				return res.status(404).send('Device not found') if !device?
				return res.status(410).send('Device deleted') if device.markedForDeletion
				throw new Error('Device is invalid') if !device.deviceId?
				Promise.try =>
					if !_.isEmpty(fieldsToUpdateOnAPI)
						@proxyvisor.apiBinder.patchDevice(device.deviceId, fieldsToUpdateOnAPI)
				.then =>
					@db.models('dependentDevice').update(fieldsToUpdateOnDB).where({ uuid })
				.then =>
					@db.models('dependentDevice').select().where({ uuid })
				.then ([ device ]) ->
					res.json(parseDeviceFields(device))
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.get '/v1/dependent-apps/:appId/assets/:commit', (req, res) =>
			@db.models('dependentApp').select().where(_.pick(req.params, 'appId', 'commit'))
			.then ([ app ]) =>
				return res.status(404).send('Not found') if !app
				dest = tarPath(app.appId, app.commit)
				fs.lstatAsync(dest)
				.catch =>
					Promise.using @docker.imageRootDirMounted(app.image), (rootDir) ->
						getTarArchive(rootDir + '/assets', dest)
				.then ->
					res.sendFile(dest)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.get '/v1/dependent-apps', (req, res) =>
			@db.models('dependentApp').select()
			.map (app) ->
				return {
					id: parseInt(app.appId)
					commit: app.commit
					name: app.name
					config: JSON.parse(app.config ? '{}')
				}
			.then (apps) ->
				res.json(apps)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(503).send(err?.message or err or 'Unknown error')

module.exports = class Proxyvisor
	constructor: ({ @config, @logger, @db, @docker, @images, @applications }) ->
		@acknowledgedState = {}
		@lastRequestForDevice = {}
		@_router = new ProxyvisorRouter(this)
		@router = @_router.router
		@actionExecutors = {
			updateDependentTargets: (step) =>
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

			sendDependentHooks: (step) =>
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

			removeDependentApp: (step) =>
				# find step.app and delete it from the DB
				# find devices with step.appId and delete them from the DB
				@db.transaction (trx) ->
					trx('dependentApp').where({ appId: step.appId }).del()
					.then ->
						trx('dependentDevice').where({ appId: step.appId }).del()
					.then ->
						cleanupTars(step.appId)

		}
		@validActions = _.keys(@actionExecutors)

	bindToAPI: (apiBinder) =>
		@apiBinder = apiBinder

	executeStepAction: (step) =>
		Promise.try =>
			throw new Error("Invalid proxyvisor action #{step.action}") if !@actionExecutors[step.action]?
			@actionExecutors[step.action](step)

	getCurrentStates: =>
		Promise.join(
			@db.models('dependentApp').select().map(@normaliseDependentAppFromDB)
			@db.models('dependentDevice').select()
			(apps, devicesFromDB) ->
				devices = _.map devicesFromDB, (device) ->
					dev = {
						uuid: device.uuid
						name: device.name
						lock_expiry_date: device.lock_expiry_date
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
			imageId: app.imageId
			parentApp: app.parentApp
			image: image
			config: JSON.stringify(app.config ? {})
			environment: JSON.stringify(app.environment ? {})
		}
		return Promise.props(dbApp)

	normaliseDependentDeviceTargetForDB: (device, appCommit) ->
		Promise.try ->
			apps = _.mapValues _.clone(device.apps ? {}), (app) ->
				app.commit = appCommit or null
				app.config ?= {}
				app.environment ?= {}
				return app
			apps = JSON.stringify(apps)
			outDevice = {
				uuid: device.uuid
				name: device.name
				apps
			}
			return outDevice

	setTargetInTransaction: (dependent, trx) =>
		Promise.try =>
			if dependent?.apps?
				appsArray = _.map dependent.apps, (app, appId) ->
					appClone = _.clone(app)
					appClone.appId = checkInt(appId)
					return appClone
				Promise.map(appsArray, @normaliseDependentAppForDB)
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
					@normaliseDependentDeviceTargetForDB(device, dependent.apps[appId]?.commit)
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
				imageId: app.imageId
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
				apps: _.mapValues JSON.parse(device.apps), (a) ->
					a.commit ?= null
					return a

			}
			return outDevice

	normaliseDependentDeviceFromDB: (device) ->
		Promise.try ->
			outDevice = _.clone(device)
			for prop in [ 'environment', 'config', 'targetEnvironment', 'targetConfig' ]
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
			for app in current.dependent.apps
				images.push app.image
		if target.dependent?.apps?
			for app in target.dependent.apps
				images.push app.image
		return images

	_imageAvailable: (image, available) ->
		_.some(available, (availableImage) -> availableImage.name == image)

	_getHookStep: (currentDevices, appId) =>
		hookStep = {
			action: 'sendDependentHooks'
			devices: []
			appId
		}
		for device in currentDevices
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
			delete devTarget.lock_expiry_date
			devTarget.apps = {}
			devTarget.apps[appId] = {
				commit: dev.apps[appId].targetCommit
				environment: dev.apps[appId].targetEnvironment or {}
				config: dev.apps[appId].targetConfig or {}
			}
			return devTarget
		currentDeviceTargets = _.filter(currentDeviceTargets, (dev) -> !_.isNull(dev))
		return !_.isEmpty(_.xorWith(currentDeviceTargets, targetDevices, _.isEqual))

	imageForDependentApp: (app) ->
		return {
			name: app.image
			imageId: app.imageId
			appId: app.appId
			dependent: true
		}

	nextStepsForDependentApp: (appId, availableImages, downloading, current, target, currentDevices, targetDevices, stepsInProgress) =>
		# - if there's current but not target, push a removeDependentApp step
		if !target?
			return [{
				action: 'removeDependentApp'
				appId: current.appId
			}]

		if _.some(stepsInProgress, (step) -> step.appId == target.parentApp)
			return [{ action: 'noop' }]

		needsDownload = target.commit? and target.image? and !@_imageAvailable(target.image, availableImages)

		# - if toBeDownloaded includes this app, push a fetch step
		if needsDownload
			if target.imageId in downloading
				return [{ action: 'noop' }]
			else
				return [{
					action: 'fetch'
					appId
					image: @imageForDependentApp(target)
				}]

		devicesDiffer = @_compareDevices(currentDevices, targetDevices, appId)

		# - if current doesn't match target, or the devices differ, push an updateDependentTargets step
		if !_.isEqual(current, target) or devicesDiffer
			return [{
				action: 'updateDependentTargets'
				devices: targetDevices
				app: target
				appId
			}]

		# if we got to this point, the current app is up to date and devices have the
		# correct targetCommit, targetEnvironment and targetConfig.
		hookStep = @_getHookStep(currentDevices, appId)
		if !_.isEmpty(hookStep.devices)
			return [ hookStep ]
		return []

	getRequiredSteps: (availableImages, downloading, current, target, stepsInProgress) =>
		steps = []
		Promise.try =>
			targetApps = _.keyBy(target.dependent?.apps ? [], 'appId')
			targetAppIds = _.keys(targetApps)
			currentApps = _.keyBy(current.dependent?.apps ? [], 'appId')
			currentAppIds = _.keys(currentApps)
			allAppIds = _.union(targetAppIds, currentAppIds)

			for appId in allAppIds
				devicesForApp = (devices) ->
					_.filter devices, (d) ->
						_.includes(_.keys(d.apps), appId)

				currentDevices = devicesForApp(current.dependent.devices)
				targetDevices = devicesForApp(target.dependent.devices)
				stepsForApp = @nextStepsForDependentApp(appId, availableImages, downloading,
					currentApps[appId], targetApps[appId],
					currentDevices, targetDevices,
					stepsInProgress)
				steps = steps.concat(stepsForApp)
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
