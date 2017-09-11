Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
request = require './lib/request'
constants = require './lib/constants'
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
	return "/var/tmp/resin-supervisor/dependent-assets/#{appId}"

tarFilename = (appId, commit) ->
	return "#{appId}-#{commit}.tar"

tarPath = (appId, commit) ->
	return "#{tarDirectory(appId)}/#{tarFilename(appId, commit)}"

getTarArchive = (file, destination) ->
	fs.lstatAsync(path)
	.then ->
		mkdirp(path.dirname(file))
		.then ->
			execAsync("tar -cvf '#{destination}' *", cwd: path)

cleanupTars = (appId, commit) ->
	if commit?
		fileToKeep = tarPath(appId, commit)
	else
		fileToKeep = null
	fs.readdirAsync(tarDirectory(appId))
	.catchReturn([])
	.then (files) ->
		if fileToKeep?
			files = _.filter files, (file) ->
				return file isnt fileToKeep
		Promise.map files, (file) ->
			if !fileToKeep? or (file isnt fileToKeep)
				fs.unlinkAsync(file)

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
		{ @config, @logger, @db, @docker, @apiBinder, @reportCurrentState } = @proxyvisor
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
			device_type = 'generic-amd64' if !device_type?
			d =
				application: req.body.appId
				device_type: device_type
			@apiBinder.provisionDependentDevice(d)
			.then (dev) =>
				# If the response has id: null then something was wrong in the request
				# but we don't know precisely what.
				if !dev.id?
					res.status(400).send('Provisioning failed, invalid appId or credentials')
					return
				deviceForDB = {
					uuid: dev.uuid
					appId: dev.application
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
						@apiBinder.patchDevice(device.deviceId, fieldsToUpdateOnAPI)
				.then =>
					@db.models('dependentDevice').update(fieldsToUpdateOnDB).where({ uuid })
				.then ->
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
	constructor: ({ @config, @logger, @db, @docker, @images, @applications, @reportCurrentState }) ->
		@acknowledgedState = {}
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
							targetCommit = step.app.commit
							targetEnvironment = device.apps[appId].environment
							targetConfig = device.apps[appId].config
							@db.models('dependentDevice').update({ targetEnvironment, targetConfig, targetCommit, name: device.name }).where({ uuid })
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
							@db.models('dependentDevice').whereNotIn('uuid', _.map(step.devices, 'uuid')).update({ markedForDeletion: true })
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
								if device.markedForDeletion
									@sendDeleteHook(device, apiTimeout, endpoint)
								else
									@sendUpdate(device, apiTimeout, endpoint)
					)
					.then ->
						cleanupTars(step.appId)

				removeDependentApp: =>
					# find step.app and delete it from the DB
					# find devices with step.appId and delete them from the DB
					@db.transaction (trx) ->
						trx('dependentApp').where({ appId: step.appId }).del()
						.then ->
							trx('dependentDevice').where({ appId: step.appId }).del()

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
						apps: {}
					}
					dev.apps[device.appId] = {
						commit: device.commit
						config: JSON.parse(device.config)
						environment: JSON.parse(device.environment)
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

	normaliseDependentDeviceTargetForDB: (device) ->
		Promise.try ->
			apps = JSON.stringify(device.apps ? {})
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
				Promise.map(dependent.devices, @normaliseDependentDeviceTargetForDB)
				.then (devicesForDB) =>
					Promise.map devicesForDB, (device) =>
						device.apps = _.mapValues device.apps, (app, appId) ->
							app.commit ?= appsByAppId[appId]?.commit
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

			_.map allAppIds, (appId) ->
				# - if a step is in progress for this appId, ignore
				if _.some(steps.concat(stepsInProgress), (step) -> step.appId == appId)
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
				# - if there's current but not target, push a removeDependentApp step
				if !targetApps[appId]?
					steps.push({
						action: 'removeDependentApp'
						appId
					})
					return

				devicesForApp = (devices) ->
					_.filter devices, (d) ->
						_.includes(_.keys(d.apps), appId)

				currentDevices = devicesForApp(current.dependent.devices)
				targetDevices = devicesForApp(target.dependent.devices)
				targetDevicesByUuid = _.keyBy(targetDevices, 'uuid')
				devicesDiffer = !_.isEmpty(_.difference(currentDevices, targetDevices).concat(_.difference(targetDevices, currentDevices)))
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
				hookStep = {
					action: 'sendDependentHooks'
					devices: []
					appId
				}
				_.forEach currentDevices, (device) ->
					target = targetDevicesByUuid[device.uuid]
					if !target?
						hookStep.devices.push({
							uuid: device.uuid
							markedForDeletion: true
						})
					else
						targetState = {
							appId
							commit: targetApps[appId].commit
							config: target.config
							environment: target.environment
						}
						currentState = {
							appId
							commit: targetApps[appId].commit
							config: device.config
							environment: device.environment
						}
						if targetApps[appId].commit? and !_.isEqual(targetState, currentState) and !_.isEqual(targetState, @acknowledgedState[device.uuid])
							hookStep.devices.push({
								uuid: device.uuid
								target: targetState
							})
				if !_.isEmpty(hookStep.devices)
					steps.push(hookStep)
		.then ->
			return steps

	getHookEndpoint: (appId) =>
		@db.models('dependentApp').select('parentAppId').where({ appId })
		.then ([ { parentAppId } ]) =>
			@applications.getCurrentApp(parentAppId)
		.then (parentApp) =>
			Promise.map parentApp?.services ? [], (service) =>
				@docker.getImageEnv(service.image)
				.then (imageEnv) ->
					return imageEnv.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS
			.then (imageHookAddresses) ->
				for addr in imageHookAddresses
					return addr if addr?
				return parentApp.config.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS ?
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
