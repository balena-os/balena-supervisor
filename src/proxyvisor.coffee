Promise = require 'bluebird'
dockerUtils = require './docker-utils'
{ docker } = dockerUtils
express = require 'express'
fs = Promise.promisifyAll require 'fs'
{ resinApi, request } = require './request'
knex = require './db'
_ = require 'lodash'
deviceRegister = require 'resin-register-device'
randomHexString = require './lib/random-hex-string'
utils = require './utils'
device = require './device'
bodyParser = require 'body-parser'
appConfig = require './config'
execAsync = Promise.promisify(require('child_process').exec)
url = require 'url'

isDefined = _.negate(_.isUndefined)

exports.router = router = express.Router()
router.use(bodyParser())

parseDeviceFields = (device) ->
	device.id = parseInt(device.deviceId)
	device.appId = parseInt(device.appId)
	device.config = JSON.parse(device.config ? '{}')
	device.environment = JSON.parse(device.environment ? '{}')
	device.targetConfig = JSON.parse(device.targetConfig ? '{}')
	device.targetEnvironment = JSON.parse(device.targetEnvironment ? '{}')
	return _.omit(device, 'markedForDeletion')


router.get '/v1/devices', (req, res) ->
	knex('dependentDevice').select()
	.map(parseDeviceFields)
	.then (devices) ->
		res.json(devices)
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

router.post '/v1/devices', (req, res) ->
	appId = req.body.appId
	if !appId? or _.isNaN(parseInt(appId)) or parseInt(appId) <= 0
		res.status(400).send('appId must be a positive integer')
		return
	Promise.join(
		utils.getConfig('apiKey')
		utils.getConfig('userId')
		device.getID()
		randomHexString.generate()
		(apiKey, userId, deviceId) ->
			uuid = deviceRegister.generateUniqueKey()
			d =
				user: userId
				application: req.body.appId
				uuid: uuid
				device_type: 'edge'
				device: deviceId
				registered_at: Math.floor(Date.now() / 1000)
				logs_channel: null
				status: 'Provisioned'
			resinApi.post
				resource: 'device'
				body: d
				customOptions:
					apikey: apiKey
			.timeout(appConfig.apiTimeout)
			.then (dev) ->
				# If the response has id: null then something was wrong in the request
				# but we don't know precisely what.
				if !dev.id?
					res.status(400).send('Provisioning failed, invalid appId or credentials')
					return
				deviceForDB = {
					uuid: uuid
					appId: appId
					device_type: d.device_type
					deviceId: dev.id
					name: dev.name
					status: d.status
					logs_channel: null
				}
				knex('dependentDevice').insert(deviceForDB)
				.then ->
					res.status(201).send(dev)
	)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

router.get '/v1/devices/:uuid', (req, res) ->
	uuid = req.params.uuid
	knex('dependentDevice').select().where({ uuid })
	.then ([ device ]) ->
		return res.status(404).send('Device not found') if !device?
		return res.status(410).send('Device deleted') if device.markedForDeletion
		res.json(parseDeviceFields(device))
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

router.post '/v1/devices/:uuid/logs', (req, res) ->
	uuid = req.params.uuid
	m = {
		message: req.body.message
		timestamp: req.body.timestamp or Date.now()
	}
	m.isSystem = req.body.isSystem if req.body.isSystem?

	knex('dependentDevice').select().where({ uuid })
	.then ([ device ]) ->
		return res.status(404).send('Device not found') if !device?
		return res.status(410).send('Device deleted') if device.markedForDeletion

		logger.logDependent(m, uuid)
		res.status(202).send('OK')
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

validStringOrUndefined = (s) ->
	_.isUndefined(s) or !_.isEmpty(s)
validObjectOrUndefined = (o) ->
	_.isUndefined(o) or _.isObject(o)

router.put '/v1/devices/:uuid', (req, res) ->
	uuid = req.params.uuid
	{ status, is_online, commit, environment, config } = req.body
	if isDefined(is_online) and !_.isBoolean(is_online)
		res.status(400).send('is_online must be a boolean')
		return
	if !validStringOrUndefined(status)
		res.status(400).send('status must be a non-empty string')
		return
	if !validStringOrUndefined(commit)
		res.status(400).send('commit must be a non-empty string')
		return
	if !validObjectOrUndefined(environment)
		res.status(400).send('environment must be an object')
		return
	if !validObjectOrUndefined(config)
		res.status(400).send('config must be an object')
		return
	environment = JSON.stringify(environment) if isDefined(environment)
	config = JSON.stringify(config) if isDefined(config)

	fieldsToUpdateOnDB = _.pickBy({ status, is_online, commit, config, environment }, isDefined)
	fieldsToUpdateOnAPI = _.pick(fieldsToUpdateOnDB, 'status', 'is_online', 'commit')

	if _.isEmpty(fieldsToUpdateOnDB)
		res.status(400).send('At least one device attribute must be updated')
		return

	Promise.join(
		utils.getConfig('apiKey')
		knex('dependentDevice').select().where({ uuid })
		(apiKey, [ device ]) ->
			throw new Error('apikey not found') if !apiKey?
			return res.status(404).send('Device not found') if !device?
			return res.status(410).send('Device deleted') if device.markedForDeletion
			throw new Error('Device is invalid') if !device.deviceId?
			Promise.try ->
				if !_.isEmpty(fieldsToUpdateOnAPI)
					resinApi.patch
						resource: 'device'
						id: device.deviceId
						body: fieldsToUpdateOnAPI
						customOptions:
							apikey: apiKey
					.timeout(appConfig.apiTimeout)
			.then ->
				knex('dependentDevice').update(fieldsToUpdateOnDB).where({ uuid })
			.then ->
				res.json(parseDeviceFields(device))
	)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

tarPath = ({ appId, commit }) ->
	return '/tmp/' + appId + '-' + commit + '.tar'

router.get '/v1/dependent-apps/:appId/assets/:commit', (req, res) ->
	knex('dependentApp').select().where(_.pick(req.params, 'appId', 'commit'))
	.then ([ app ]) ->
		return res.status(404).send('Not found') if !app
		dest = tarPath(app)
		fs.lstatAsync(dest)
		.catch ->
			Promise.using docker.imageRootDirMounted(app.imageId), (rootDir) ->
				getTarArchive(rootDir + '/assets', dest)
		.then ->
			res.sendFile(dest)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

router.get '/v1/dependent-apps', (req, res) ->
	knex('dependentApp').select()
	.map (app) ->
		return {
			id: parseInt(app.appId)
			commit: app.commit
			device_type: 'edge'
			name: app.name
			config: JSON.parse(app.config ? '{}')
		}
	.then (apps) ->
		res.json(apps)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

getTarArchive = (path, destination) ->
	fs.lstatAsync(path)
	.then ->
		execAsync("tar -cvf '#{destination}' *", cwd: path)

# TODO: deduplicate code from compareForUpdate in application.coffee
exports.fetchAndSetTargetsForDependentApps = (state, fetchFn, apiKey) ->
	knex('dependentApp').select()
	.then (localDependentApps) ->
		# Compare to see which to fetch, and which to delete
		remoteApps = _.mapValues state.apps, (app, appId) ->
			conf = app.config ? {}
			return {
				appId: appId
				parentAppId: app.parentApp
				imageId: app.image
				commit: app.commit
				config: JSON.stringify(conf)
				name: app.name
			}
		localApps = _.keyBy(localDependentApps, 'appId')

		toBeDownloaded = _.filter remoteApps, (app, appId) ->
			return app.commit? and app.imageId? and !_.some(localApps, imageId: app.imageId)
		toBeRemoved = _.filter localApps, (app, appId) ->
			return app.commit? and !_.some(remoteApps, imageId: app.imageId)
		toBeDeletedFromDB = _(localApps).reject((app, appId) -> remoteApps[appId]?).map('appId').value()
		Promise.map toBeDownloaded, (app) ->
			fetchFn(app, false)
		.then ->
			Promise.map toBeRemoved, (app) ->
				fs.unlinkAsync(tarPath(app))
				.then ->
					docker.getImage(app.imageId).removeAsync()
				.catch (err) ->
					console.error('Could not remove image/artifacts for dependent app', err, err.stack)
		.then ->
			Promise.props(
				_.mapValues remoteApps, (app, appId) ->
					knex('dependentApp').update(app).where({ appId })
					.then (n) ->
						knex('dependentApp').insert(app) if n == 0
			)
		.then ->
			knex('dependentDevice').del().whereIn('appId', toBeDeletedFromDB)
		.then ->
			knex('dependentApp').del().whereIn('appId', toBeDeletedFromDB)
		.then ->
			knex('dependentDevice').update({ markedForDeletion: true }).whereNotIn('uuid', _.keys(state.devices))
		.then ->
			Promise.all _.map state.devices, (device, uuid) ->
				# Only consider one app per dependent device for now
				appId = _(device.apps).keys().head()
				targetCommit = state.apps[appId].commit
				targetEnvironment = JSON.stringify(device.apps[appId].environment ? {})
				targetConfig = JSON.stringify(device.apps[appId].config ? {})
				knex('dependentDevice').update({ targetEnvironment, targetConfig, targetCommit, name: device.name }).where({ uuid })
				.then (n) ->
					return if n != 0
					# If the device is not in the DB it means it was provisioned externally
					# so we need to fetch it.
					resinApi.get
						resource: 'device'
						options:
							filter:
								uuid: uuid
						customOptions:
							apikey: apiKey
					.timeout(appConfig.apiTimeout)
					.then ([ dev ]) ->
						deviceForDB = {
							uuid: uuid
							appId: appId
							device_type: dev.device_type
							deviceId: dev.id
							is_online: dev.is_online
							name: dev.name
							status: dev.status
							logs_channel: null
							targetCommit
							targetConfig
							targetEnvironment
						}
						knex('dependentDevice').insert(deviceForDB)
	.catch (err) ->
		console.error('Error fetching dependent apps', err, err.stack)

getHookEndpoint = (appId) ->
	knex('dependentApp').select('parentAppId').where({ appId })
	.then ([ { parentAppId } ]) ->
		utils.getKnexApp(parentAppId)
	.then (parentApp) ->
		conf = JSON.parse(parentApp.config)
		dockerUtils.getImageEnv(parentApp.imageId)
		.then (imageEnv) ->
			return imageEnv.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS ?
				conf.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS ?
				"#{appConfig.proxyvisorHookReceiver}/v1/devices/"

formatTargetAsState = (device) ->
	return {
		commit: device.targetCommit
		environment: device.targetEnvironment
		config: device.targetConfig
	}

do ->
	acknowledgedState = {}
	sendUpdate = (device, endpoint) ->
		stateToSend = {
			appId: parseInt(device.appId)
			commit: device.targetCommit
			environment: JSON.parse(device.targetEnvironment)
			config: JSON.parse(device.targetConfig)
		}
		request.putAsync "#{endpoint}#{device.uuid}", {
			json: true
			body: stateToSend
		}
		.timeout(appConfig.apiTimeout)
		.spread (response, body) ->
			if response.statusCode == 200
				acknowledgedState[device.uuid] = formatTargetAsState(device)
			else
				acknowledgedState[device.uuid] = null
				throw new Error("Hook returned #{response.statusCode}: #{body}") if response.statusCode != 202
		.catch (err) ->
			return console.error("Error updating device #{device.uuid}", err, err.stack)

	sendDeleteHook = (device, endpoint) ->
		uuid = device.uuid
		request.delAsync("#{endpoint}#{uuid}")
		.timeout(appConfig.apiTimeout)
		.spread (response, body) ->
			if response.statusCode == 200
				knex('dependentDevice').del().where({ uuid })
			else
				throw new Error("Hook returned #{response.statusCode}: #{body}")
		.catch (err) ->
			return console.error("Error deleting device #{device.uuid}", err, err.stack)

	exports.sendUpdates = ->
		endpoints = {}
		knex('dependentDevice').select()
		.map (device) ->
			currentState = _.pick(device, 'commit', 'environment', 'config')
			targetState = formatTargetAsState(device)
			endpoints[device.appId] ?= getHookEndpoint(device.appId)
			endpoints[device.appId]
			.then (endpoint) ->
				if device.markedForDeletion
					sendDeleteHook(device, endpoint)
				else if device.targetCommit? and !_.isEqual(targetState, currentState) and !_.isEqual(targetState, acknowledgedState[device.uuid])
					sendUpdate(device, endpoint)
