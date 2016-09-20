Promise = require 'bluebird'
dockerUtils = require './docker-utils'
{ docker } = dockerUtils
express = require 'express'
fs = Promise.promisifyAll require 'fs'
{ resinApi } = require './request'
knex = require './db'
_ = require 'lodash'
deviceRegister = require 'resin-register-device'
randomHexString = require './lib/random-hex-string'
utils = require './utils'
device = require './device'
bodyParser = require 'body-parser'
request = Promise.promisifyAll require 'request'
config = require './config'
PUBNUB = require 'pubnub'
execAsync = Promise.promisify(require('child_process').exec)

pubnub = PUBNUB.init(config.pubnub)

getAssetsPath = (image) ->
	docker.imageRootDir(image)
	.then (rootDir) ->
		return rootDir + '/assets'

exports.router = router = express.Router()
router.use(bodyParser())

router.get '/v1/devices', (req, res) ->
	knex('dependentDevice').select()
	.then (devices) ->
		res.json(devices)
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

router.post '/v1/devices', (req, res) ->
	Promise.join(
		utils.getConfig('apiKey')
		utils.getConfig('userId')
		device.getID()
		deviceRegister.generateUUID()
		randomHexString.generate()
		(apiKey, userId, deviceId, uuid, logsChannel) ->
			d =
				user: userId
				application: req.body.applicationId
				uuid: uuid
				device_type: 'edge'
				device: deviceId
				registered_at: Math.floor(Date.now() / 1000)
				logs_channel: logsChannel
				status: 'Provisioned'
			resinApi.post
				resource: 'device'
				body: d
				customOptions:
					apikey: apiKey
			.then (dev) ->
				deviceForDB = {
					uuid: uuid
					appId: d.application
					device_type: d.device_type
					deviceId: dev.id
					name: dev.name
					status: d.status
					logs_channel: d.logs_channel
				}
				knex('dependentDevice').insert(deviceForDB)
				.then ->
					res.status(202).send(dev)
	)
	.catch (err) ->
		console.error('Error on GET /v1/devices:', err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

router.get '/v1/devices/:uuid', (req, res) ->
	uuid = req.params.uuid
	knex('dependentDevice').select().where({ uuid })
	.then ([ device ]) ->
		return res.status(404).send('Device not found') if !device?
		res.json(device)
	.catch (err) ->
		console.error('Error on GET /v1/devices/:uuid:', err, err.stack)
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
		pubnub.publish({ channel: "device-#{device.logs_channel}-logs", message: m })
		res.status(202).send('OK')
	.catch (err) ->
		console.error('Error on PUT /v1/devices/:uuid/logs:', err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

router.put '/v1/devices/:uuid', (req, res) ->
	uuid = req.params.uuid
	status = req.body.status
	is_online = req.body.is_online
	if is_online? and !_.isBoolean(is_online)
		res.status(400).send('is_online must be a boolean')
		return
	if status? and _.isEmpty(status)
		res.status(400).send('status cannot be empty')
		return
	Promise.join(
		utils.getConfig('apiKey')
		knex('dependentDevice').select().where({ uuid })
		(apiKey, [ device ]) ->
			throw new Error('apikey not found') if !apiKey?
			return res.status(404).send('Device not found') if !device?
			resinApi.patch
				resource: 'device'
				id: device.deviceId
				body: { status, is_online }
				customOptions:
					apikey: apiKey
			.then ->
				device.status = status
				device.is_online = is_online
				knex('dependentDevice').update(device).where({ uuid })
			.then ->
				res.json(device)
	)
	.catch (err) ->
		console.error('Error on PUT /v1/devices:', err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

tarPath = (app) ->
	return '/tmp/' + app.commit + '.tar'

router.get '/v1/assets/:appId/:commit', (req, res) ->
	knex('dependentApp').select().where(_.pick(req.params, 'appId', 'commit'))
	.then ([ app ]) ->
		return res.status(404).send('Not found') if !app
		dest = tarPath(app)
		getAssetsPath(app.imageId)
		.then (path) ->
			getTarArchive(path, dest)
		.then ->
			res.sendFile(dest)
	.catch (err) ->
		console.error('Error on GET /v1/assets/:commit:', err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

router.get '/v1/dependent-apps', (req, res) ->
	knex('dependentApp').select()
	.map (app) ->
		return {
			id: app.appId
			commit: app.commit
			device_type: 'edge'
			config: app.config
		}
	.then (apps) ->
		res.json(apps)
	.catch (err) ->
		console.error('Error on GET /v1/dependent-apps', err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

getTarArchive = (path, destination) ->
	fs.lstatAsync(path)
	.then ->
		execAsync("cd #{path} && tar -cvf #{destination} *")

# TODO: deduplicate code from compareForUpdate in application.coffee
exports.fetchAndSetTargetsForDependentApps = (state, fetchFn) ->
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
			}
		localApps = _.indexBy(localDependentApps, 'appId')

		toBeDownloaded = _.filter remoteApps, (app, appId) ->
			return  app.commit? and app.imageId? and !_.any(localApps, imageId: app.imageId)
		toBeRemoved = _.filter localApps, (app, appId) ->
			return app.commit? and !_.any(remoteApps, imageId: app.imageId)
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
			Promise.all _.map state.devices, (device, uuid) ->
				# Only consider one app per dependent device for now
				appId = _(device.apps).keys().first()
				knex('dependentDevice').update({
					targetEnvironment: JSON.stringify(device.environment),
					targetConfig: JSON.stringify(device.config),
					targetCommit: state.apps[appId].commit
				}).where({ uuid })
	.catch (err) ->
		console.error('Error fetching dependent apps', err, err.stack)

sendUpdate = (device, endpoint) ->
	request.putAsync "#{endpoint}#{device.uuid}", {
		json: true
		body:
			appId: device.appId
			commit: device.targetCommit
			environment: JSON.parse(device.targetEnvironment)
			config: JSON.parse(device.targetConfig)
	}
	.spread (response, body) ->
		if response.statusCode != 200
			return console.log("Error updating device #{device.uuid}: #{response.statusCode} #{body}")
		updatedFields = { environment: device.targetEnvironment, commit: device.targetCommit, config: device.targetConfig }
		knex('dependentDevice').update(updatedFields).where({ uuid: device.uuid })

getHookEndpoint = (appId) ->
	knex('dependentApp').select('parentAppId').where({ appId })
	.then ([ { parentAppId } ]) ->
		knex('app').select().where({ appId: parentAppId })
	.then ([ parentApp ]) ->
		conf = JSON.parse(parentApp.config)
		dockerUtils.getImageEnv(parentApp.imageId)
		.then (imageEnv) ->
			return imageEnv.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS ?
				conf.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS ?
				"#{config.proxyvisorHookReceiver}/v1/devices/"

exports.sendUpdates = ->
	endpoints = {}
	knex('dependentDevice').select()
	.map (device) ->
		currentState = _.pick(device, 'commit', 'environment', 'config')
		targetState = {
			commit: device.targetCommit
			environment: device.targetEnvironment
			config: device.targetConfig
		}
		if device.targetCommit? and !_.isEqual(targetState, currentState)
			endpoints[device.appId] ?= getHookEndpoint(device.appId)
			endpoints[device.appId]
			.then (endpoint) ->
				sendUpdate(device, endpoint)
