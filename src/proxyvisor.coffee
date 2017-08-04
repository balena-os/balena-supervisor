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
PUBNUB = require 'pubnub'
execAsync = Promise.promisify(require('child_process').exec)
url = require 'url'

pubnub = PUBNUB.init(appConfig.pubnub)

isDefined = _.negate(_.isUndefined)

exports.router = router = express.Router()
router.use(bodyParser())

parseApplicationFields = (application) ->
	return {
		id: parseInt(application.appId)
		name: application.name
		commit: application.commit
		environment: JSON.parse(application.environment ? '{}')
		config: JSON.parse(application.config ? '{}')
	}

parseDeviceFields = (device) ->
	return {
		id: parseInt(device.deviceId)
		uuid: device.uuid
		appId: parseInt(device.appId)
		localId: device.localId
		device: device.device
		name: device.name
		commit: device.commit
		target_commit: device.targetCommit
		environment: JSON.parse(device.environment ? '{}')
		target_environment: JSON.parse(device.targetEnvironment ? '{}')
		config: JSON.parse(device.config ? '{}')
		target_config: JSON.parse(device.targetConfig ? '{}')
		status: device.status
		is_online: device.is_online
		download_progress: parseFloat(device.download_progress)
		lock_expiry_date: device.lock_expiry_date
	}

tarPath = ({ appId, commit }) ->
	return '/tmp/' + appId + '-' + commit + '.tar'

getTarArchive = (path, destination) ->
	fs.lstatAsync(path)
	.then ->
		execAsync("tar -cvf '#{destination}' *", cwd: path)

validStringOrUndefined = (s) ->
	_.isUndefined(s) or !_.isEmpty(s)
validObjectOrUndefined = (o) ->
	_.isUndefined(o) or _.isObject(o)

router.get '/v2/application', (req, res) ->
	knex('dependentApp').select()
	.map (parseApplicationFields)
	.then (applications) ->
		res.json(applications)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

router.get '/v2/application/:id', (req, res) ->
	appId = req.params.id
	knex('dependentApp').select().where({ appId })
	.then ([ application ]) ->
		return res.status(404).send('Application not found') if !application?
		res.json(parseApplicationFields(application))
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

router.get '/v2/application/:id/update/asset', (req, res) ->
	appId = req.params.id
	knex('dependentApp').select().where({ appId })
	.then ([ app ]) ->
		return res.status(404).send('Not found') if !app
		return res.status(404).send('No commit') if !app.commit

		dest = tarPath(app)
		fs.lstatAsync(dest)
		.catch ->
			Promise.using docker.imageRootDirMounted(app.imageId), (rootDir) ->
				getTarArchive(rootDir + '/assets', dest)
		.then ->
			res.sendFile(dest)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

# TODO figure out why this function still only returns the contents of /asset
router.get '/v2/application/:id/update/image', (req, res) ->
	appId = req.params.id
	knex('dependentApp').select().where({ appId })
	.then ([ app ]) ->
		return res.status(404).send('Not found') if !app
		return res.status(404).send('No commit') if !app.commit

		dest = tarPath(app)
		fs.lstatAsync(dest)
		.catch ->
			stream = fs.createWriteStream(dest)
			dockerUtils.getImageTarStream(app.imageId)
			.then (tarStream) ->
				new Promise (resolve, reject) ->
					tarStream
					.on('error', reject)
					.on('finish', resolve)
					.pipe(stream)
		.then ->
			res.sendFile(dest)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

# TODO: test pending filters work
router.get '/v2/device', (req, res) ->
	appId = req.query.appId
	device = req.query.device
	# pending = req.query.pending
	result = knex('dependentDevice').select()
	result = result.where({ appId }) if appId?
	result = result.where({ device }) if device?

	# if pending?
	# 	pending.forEach value ->
	# 		switch value
	# 			when 'update' then result = result.whereRaw('commit <> targetCommit')
	# 			when 'environment' then result = result.whereRaw('environment <> targetEnvironment')
	# 			when 'config' then result = result.whereRaw('config <> targetConfig')
	# 			else return

	result
	.map(parseDeviceFields)
	.then (devices) ->
		res.json(devices)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

router.get '/v2/device/:id', (req, res) ->
	idType = req.query.idType
	if !idType?
		return res.status(400).send('idType not found')
	if idType == 'resin'
		query = { 'uuid': req.params.id }
	else if idType == 'local'
		query = { 'localId': req.params.id }
	else
		return res.status(400).send('idType must be equal to resin or local')

	knex('dependentDevice').select().where(query)
	.then ([ device ]) ->
		return res.status(404).send('Device not found') if !device?
		res.json(parseDeviceFields(device))
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

router.post '/v2/device/provision', (req, res) ->
	{ appId, localId, device_type } = req.body

	if !appId? or _.isNaN(parseInt(appId)) or parseInt(appId) <= 0
		return res.status(400).send('appId must be a positive integer')
	if !localId?
		return res.status(400).send('localId not found')
	device_type = 'generic-amd64' if !device_type?

	Promise.join(
		utils.getConfig('apiKey')
		utils.getConfig('userId')
		device.getID()
		randomHexString.generate()
		(apiKey, userId, deviceId, logsChannel) ->
			uuid = deviceRegister.generateUniqueKey()
			d =
				user: userId
				application: appId
				uuid: uuid
				localId: localId
				device_type: device_type # TODO: get automatically from parent app device_type
				registered_at: Math.floor(Date.now() / 1000)
				logs_channel: logsChannel
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
					return res.status(400).send('Provisioning failed, invalid appId, localId or credentials')
				deviceForDB = {
					uuid: uuid
					appId: appId
					localId: localId
					device_type: d.device_type
					deviceId: dev.id
					name: dev.name
					status: d.status
					logs_channel: d.logs_channel
				}
				knex('dependentDevice').insert(deviceForDB)
				.then ->
					knex('dependentDevice').select().where({ 'uuid': uuid })
				.then ([ device ]) ->
					res.status(201).json(parseDeviceFields(device))
	)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

# TODO implement
router.post '/v2/device/scan', (req, res) ->
	res.status(500).send('Not implemented')

# TODO test
router.patch '/v2/device/:id', (req, res) ->
	{ status, is_online, commit, environment, config, download_progress, lock_expiry_date, manage } = req.body

	idType = req.query.idType
	if !idType?
		return res.status(400).send('idType not found')
	if idType == 'resin'
		query = { 'uuid': req.params.id }
	else if idType == 'local'
		query = { 'localId': req.params.id }
	else
		return res.status(400).send('idType must be equal to resin or local')

	if !validStringOrUndefined(status)
		return res.status(400).send('status must be a non-empty string')
	if isDefined(is_online) and !_.isBoolean(is_online)
		return res.status(400).send('is_online must be a boolean')
	if !validStringOrUndefined(commit)
		return res.status(400).send('commit must be a non-empty string')
	if !validObjectOrUndefined(environment)
		return res.status(400).send('environment must be an object')
	if !validObjectOrUndefined(config)
		return res.status(400).send('config must be an object')
	if isDefined(download_progress) and (_.isNaN(parseInt(download_progress)) or parseInt(download_progress) <= 0 or parseInt(download_progress) > 100)
		return res.status(400).send('download_progress must be an integer between 0 and 100')
	if isDefined(lock_expiry_date) and parseInt(lock_expiry_date) <= 0
		return res.status(400).send('lock_expiry_date must be a valid unix time')

	environment = JSON.stringify(environment) if isDefined(environment)
	config = JSON.stringify(config) if isDefined(config)

	fieldsToUpdateOnDB = _.pickBy({ status, is_online, commit, config, environment, download_progress, lock_expiry_date }, isDefined)

	device.getID()
	.then (id) ->
		if isDefined(manage)
			if !_.isBoolean(manage)
				return res.status(400).send('manage must be a boolean')
			else if manage
				fieldsToUpdateOnDB.device = id
			else fieldsToUpdateOnDB.device = null

		fieldsToUpdateOnAPI = _.pick(fieldsToUpdateOnDB, 'status', 'is_online', 'commit', 'config', 'environment', 'download_progress', 'lock_expiry_date', 'device')

		if _.isEmpty(fieldsToUpdateOnDB)
			return res.status(400).send('At least one device attribute must be updated')

		filter =
			$or: [
				device: null
			,
				device: id
				# device: $any:
				# 	$alias: 'd'
				# 	$expr: d: id: id
			# ,
			# 	$and: [
			# 		device: $any:
			# 			$alias: 'd'
			# 			$expr: d: is_online: false
			# 	,
			# 		$or: [
			# 			lock_expiry_date: null
			# 		,
			# 			lock_expiry_date: $le: $now: {}
			# 		]
			# 	]
			]

		Promise.join(
			utils.getConfig('apiKey')
			knex('dependentDevice').select().where(query)
			(apiKey, [ device ]) ->
				throw new Error('apikey not found') if !apiKey?
				return res.status(404).send('Device not found') if !device?
				return res.status(410).send('Device deleted') if device.markedForDeletion
				throw new Error('Device is invalid') if !device.deviceId?

				Promise.try ->
					console.log('body: ', fieldsToUpdateOnAPI)
					console.log('filter: ', JSON.stringify(filter))
					resinApi.patch
						resource: 'device'
						id: device.deviceId
						body: fieldsToUpdateOnAPI
						customOptions: apikey: apiKey
						options: filter: filter
					.timeout(appConfig.apiTimeout)
					.then ->
						resinApi.get
							resource: 'device'
							id: device.deviceId
							customOptions: apikey: apiKey
							# options: filter: filter
						.timeout(appConfig.apiTimeout)
					.then ( device ) ->
						if device
							# knex('dependentDevice').update(fieldsToUpdateOnDB).where(query)
							# .then ->
							# 	knex('dependentDevice').select().where(query)
							# .then ([ device ]) ->
							return res.json(parseDeviceFields(device))
						else
							return res.status(403).send('device is managed by a different gateway')
		)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

router.post '/v2/device/:id/log', (req, res) ->
	idType = req.query.idType
	if !idType?
		return res.status(400).send('idType not found')
	if idType == 'resin'
		query = { 'uuid': req.params.id }
	else if idType == 'local'
		query = { 'localId': req.params.id }
	else
		return res.status(400).send('idType must be equal to resin or local')

	m = {
		message: req.body.message
		timestamp: req.body.timestamp or Date.now()
	}

	m.isSystem = req.body.isSystem if req.body.isSystem?
	knex('dependentDevice').select().where(query)
	.then ([ device ]) ->
		return res.status(404).send('Device not found') if !device?
		return res.status(410).send('Device deleted') if device.markedForDeletion
		pubnub.publish({ channel: "device-#{device.logs_channel}-logs", message: m })
		res.status(202).send('OK')
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(500).send(err?.message or err or 'Unknown error')

router.get '/v1/devices', (req, res) ->
	knex('dependentDevice').select()
	.map(parseDeviceFields)
	.then (devices) ->
		res.json(devices)
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

router.post '/v1/devices', (req, res) ->
	{ appId, device_type } = req.body

	if !appId? or _.isNaN(parseInt(appId)) or parseInt(appId) <= 0
		res.status(400).send('appId must be a positive integer')
		return
	device_type = 'generic-amd64' if !device_type?

	Promise.join(
		utils.getConfig('apiKey')
		utils.getConfig('userId')
		device.getID()
		randomHexString.generate()
		(apiKey, userId, deviceId, logsChannel) ->
			uuid = deviceRegister.generateUniqueKey()
			d =
				user: userId
				application: req.body.appId
				uuid: uuid
				device_type: device_type
				device: deviceId
				registered_at: Math.floor(Date.now() / 1000)
				logs_channel: logsChannel
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
					logs_channel: d.logs_channel
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
		pubnub.publish({ channel: "device-#{device.logs_channel}-logs", message: m })
		res.status(202).send('OK')
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

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
			name: app.name
			config: JSON.parse(app.config ? '{}')
		}
	.then (apps) ->
		res.json(apps)
	.catch (err) ->
		console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
		res.status(503).send(err?.message or err or 'Unknown error')

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
					docker.getImage(app.imageId).remove()
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
		# .then ->
		# 	knex('dependentDevice').update({ markedForDeletion: true }).whereNotIn('uuid', _.keys(state.devices))
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
							logs_channel: dev.logs_channel
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
				# if device.markedForDeletion
				# 	sendDeleteHook(device, endpoint)
				if device.targetCommit? and !_.isEqual(targetState, currentState) and !_.isEqual(targetState, acknowledgedState[device.uuid])
					sendUpdate(device, endpoint)
