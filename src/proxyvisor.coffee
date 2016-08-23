Promise = require 'bluebird'
{ docker } = require './docker-utils'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
tar = require 'tar-fs'
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
			device =
				user: userId
				application: req.body.applicationId
				uuid: uuid
				device_type: req.body.deviceType or 'edge'
				device: deviceId
				registered_at: Math.floor(Date.now() / 1000)
				logs_channel: logsChannel
				status: 'Provisioned'
			resinApi.post
				resource: 'device'
				body: device
				customOptions:
					apikey: apiKey
			.then (dev) ->
				deviceForDB = {
					uuid: uuid
					appId: device.application
					device_type: device.device_type
					deviceId: dev.id
					name: dev.name
					status: device.status
					logs_channel: device.logs_channel
				}
				knex('dependentDevice').insert(deviceForDB)
				.then ->
					res.status(202).send(dev)
	)
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

router.get '/v1/devices/:uuid', (req, res) ->
	uuid = req.params.uuid
	knex('dependentDevice').select().where({ uuid })
	.then ([ device ]) ->
		return res.status(404).send('Device not found') if !device?
		res.json(device)
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

router.put '/v1/devices/:uuid/logs', (req, res) ->
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
	.then ->
		res.status(202).send('OK')
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

router.put '/v1/devices/:uuid', (req, res) ->
	uuid = req.params.uuid
	status = req.body.status
	is_online = req.body.is_online
	utils.getConfig('apiKey')
	.then (apiKey) ->
		throw new Error('apikey not found') if !apiKey?
		knex('dependentDevice').select().where({ uuid })
		.then ([ device ]) ->
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
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

tarPath = (app) ->
	return '/tmp/' + app.commit + '.tar'

router.get '/v1/assets/:commit', (req, res) ->
	knex('dependentApp').select().where({ commit: req.params.commit })
	.then ([ app ]) ->
		return res.status(404).send('Not found') if !app
		dest = tarPath(app)
		getAssetsPath(app.imageId)
		.then (path) ->
			getTarArchive(path, dest)
		.then (archive) ->
			new Promise (resolve, reject) ->
				archive.on 'finish', ->
					res.sendFile(dest)
					resolve()
				archive.on('error', reject)
	.catch (err) ->
		console.error(err)
		res.status(503).send(err?.message or err or 'Unknown error')

getTarArchive = (path, destination) ->
	fs.lstatAsync(path)
	.then ->
		tarArchive = fs.createWriteStream(destination)
		tar.pack(path).pipe(tarArchive)
		.on('error', console.error)
		return tarArchive

# TODO: deduplicate code from compareForUpdate in application.coffee
exports.fetchAndSetTargetsForDependentApps = (state, fetchFn) ->
	knex('dependentApp').select()
	.then (localDependentApps) ->
		# Compare to see which to fetch, and which to delete
		remoteApps = _.mapValues state.apps, (app, appId) ->
			return {
				appId: appId
				imageId: app.image
				commit: app.commit
				env: JSON.stringify(app.environment)
			}
		localApps = _.indexBy(localDependentApps, 'appId')

		toBeDownloaded = _.values(
			_.filter remoteApps, (app, appId) ->
				return !_.any(localApps, imageId: app.imageId)
		)
		toBeRemoved = _.values(
			_.filter localApps, (app, appId) ->
				return !_.any(remoteApps, imageId: app.imageId)
		)
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
			devices = _.map state.devices, (device, uuid) ->
				device.uuid = uuid
				return device
			Promise.map devices, (device) ->
				# Only consider one app per dependent device for now
				appId = _.keys(device.apps)[0]
				knex('dependentDevice').update({ targetEnv: JSON.stringify(device.environment), targetCommit: state.apps[appId].commit }).where({ uuid: device.uuid })
	.catch (err) ->
		console.error('Error fetching dependent apps', err, err.stack)

sendUpdate = (device) ->
	request.putAsync("#{config.proxyvisorHookReceiver}/v1/devices/#{device.uuid}", { json: true, body: { commit: device.targetCommit, environment: JSON.parse(device.targetEnv) } })
	.spread (response, body) ->
		if response.statusCode != 200
			return console.log("Error updating device #{device.uuid}: #{response.statusCode} #{body}")
		knex('dependentDevice').update({ env: device.targetEnv, commit: device.targetCommit }).where({ uuid: device.uuid })

exports.sendUpdates = ->
	# Go through knex('dependentDevice') and sendUpdate if targetCommit or targetEnv differ from the current ones.
	knex('dependentDevice').select()
	.map (device) ->
		sendUpdate(device) if device.targetCommit != device.commit or not _.isEqual(device.targetEnv, device.env)
