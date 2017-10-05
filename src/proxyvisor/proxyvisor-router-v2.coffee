Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
url = require 'url'
{
	isDefined,
	parseDeviceFields,
	parseApplicationFields,
	validStringOrUndefined,
	validObjectOrUndefined,
	validBooleanOrUndefined,
	validNumberOrUndefined,
	validDateOrUndefined,
	tarPath,
	getTarArchive,
} = require './utils'

# todo
# change var names
# match validation
# strip out v1 and index changes
module.exports = class ProxyvisorRouterV2
	constructor: (@proxyvisor) ->
		{ @config, @logger, @db, @docker, @reportCurrentState } = @proxyvisor
		@router = express.Router()

		# tested
		@router.get '/application', (req, res) =>
			@db.models('dependentApp').select()
			.map (parseApplicationFields)
			.then (apps) ->
				res.json(apps)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

		# tested
		@router.get '/application/:appId', (req, res) =>
			@db.models('dependentApp').select().where(_.pick(req.params, 'appId'))
			.then ([ app ]) ->
				return res.status(404).send('Application not found') if !app?

				res.json(parseApplicationFields(app))
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

		# tested
		@router.get '/application/:appId/update/asset/:commit', (req, res) =>
			@db.models('dependentApp').select().where(_.pick(req.params, 'appId', 'commit'))
			.then ([ app ]) =>
				return res.status(404).send('Application not found') if !app?
				return res.status(404).send('Commit not found') if !app.commit?

				dest = tarPath(app.appId, app.commit)
				fs.lstatAsync(dest)
				.catch =>
					Promise.using @docker.imageRootDirMounted(app.image), (rootDir) ->
						getTarArchive(rootDir + '/assets', dest)
				.then ->
					res.sendFile(dest)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

		@router.get '/application/:appId/update/image/:commit', (req, res) =>
			@db.models('dependentApp').select().where(_.pick(req.params, 'appId', 'commit'))
			.then ([ app ]) ->
				return res.status(404).send('Application not found') if !app?
				return res.status(404).send('Commit not found') if !app.commit?

				dest = tarPath(app.appId, app.commit)
				fs.lstatAsync(dest)
				.catch =>
					stream = fs.createWriteStream(dest)
					# TODO this still returns the contents of /asset
					@docker.getImage(app.image).get()
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

		# TODO
		@router.post '/application/:app_id/scan', (req, res) =>
			{ app_id } = req.params
			{ device_type, online_devices, expiry_date } = req.body
			if !app_id? or _.isNaN(parseInt(app_id)) or parseInt(app_id) <= 0
				return res.status(400).send('app_id not found')
			if !device_type? or _.isEmpty(device_type) or !_.isString(device_type)
				return res.status(400).send('device_type not found')
			if !online_devices? or !_.isArray(online_devices)
				return res.status(400).send('online_devices not found')
			if !expiry_date? or _.isNaN(parseInt(expiry_date)) or parseInt(expiry_date) <= 0
				return res.status(400).send('expiry_date not found')

			@apiBinder.sendOnlineDependentDevices(app_id, device_type, online_devices, expiry_date)
			.then ->
				res.send()
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack) if err.code == 500
				res.status(err.code).send(err?.message or err or 'Unknown error')

		# tested
		@router.get '/device', (req, res) =>
			result = @db.models('dependentDevice').select().where(_.pick(req.query, 'appId', 'device'))
			pending = req.query.pending
			_.each pending, (value) ->
				result = switch value
					when 'update' then result.whereRaw('commit <> targetCommit')
					when 'environment' then result.whereRaw('environment <> targetEnvironment')
					when 'config' then result.whereRaw('config <> targetConfig')

			result
			.map(parseDeviceFields)
			.then (devices) ->
				res.json(devices)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

		# tested
		@router.get '/device/:uuid', (req, res) =>
			@db.models('dependentDevice').select().where(_.pick(req.params, 'uuid')).
				orWhere _.mapKeys _.pick(req.params, 'uuid'), (value, key) ->
					'local_id'
			.then ([ device ]) ->
				return res.status(404).send('Device not found') if !device?
				return res.status(410).send('Device deleted') if device.markedForDeletion

				res.json(parseDeviceFields(device))
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')


		# if device is null:
		# else if device is this device:
		# else if device is offline and lock expiry date is null or expired:

		# filter =
		# 	$or: [
		# 		device: null
		# 	,
		# 		device: id
		# 		device: $any:
		# 			$alias: 'd'
		# 			$expr: d: id: id
		# 	,
		# 		$and: [
		# 			device: $any:
		# 				$alias: 'd'
		# 				$expr: d: is_online: false
		# 		,
		# 			$or: [
		# 				lock_expiry_date: null
		# 			,
		# 				lock_expiry_date: $le: $now: {}
		# 			]
		# 		]
		# 	]

		# tested
		@router.patch '/device/:uuid', (req, res) ->
			res.status(500).send('not implemented')
			# { status, is_online, commit, environment, config, download_progress, lock_expiry_date, manage } = req.body
			# validateDeviceFields = ->
			# 	if !validStringOrUndefined(status)
			# 		return 'status must be a non-empty string'
			# 	if !validBooleanOrUndefined(is_online)
			# 		return 'is_online must be a boolean'
			# 	if !validStringOrUndefined(commit)
			# 		return 'commit must be a non-empty string'
			# 	if !validObjectOrUndefined(environment)
			# 		return 'environment must be an object'
			# 	if !validObjectOrUndefined(config)
			# 		return 'config must be an object'
			# 	if !validNumberOrUndefined(download_progress)
			# 		return 'download_progress must be an integer'
			# 	if !validDateOrUndefined(lock_expiry_date)
			# 		return 'lock_expiry_date must be a valid dateTime'
			# 	if !validBooleanOrUndefined(manage)
			# 		return 'manage must be a boolean'
			# 	return null

			# requestError = validateDeviceFields()
			# return res.status(400).send(requestError) if requestError?

			# environment = JSON.stringify(environment) if isDefined(environment)
			# config = JSON.stringify(config) if isDefined(config)

			# fieldsToUpdateOnDB = _.pickBy({ status, is_online, commit, environment, config, download_progress, lock_expiry_date }, isDefined)

			# if manage?
			# 	fieldsToUpdateOnDB.device = if manage then device.getID() else null

			# fieldsToUpdateOnAPI = _.pick(fieldsToUpdateOnDB, 'status', 'is_online', 'commit', 'config', 'environment', 'download_progress', 'lock_expiry_date', 'device')

			# return res.status(400).send('At least one device attribute must be updated') if _.isEmpty(fieldsToUpdateOnDB)

			# @db.models('dependentDevice').select().where(_.pick(req.params, 'uuid')).
			# 	orWhere _.mapKeys _.pick(req.params, 'uuid'), (value, key) ->
			# 		'local_id'
			# .then ([ device ]) =>
			# 	return res.status(404).send('Device not found') if !device?
			# 	return res.status(410).send('Device deleted') if device.markedForDeletion
			# 	throw new Error('Device is invalid') if !device.deviceId?

			# 	uuid = device.uuid
			# 	Promise.try =>
			# 		if !_.isEmpty(fieldsToUpdateOnAPI)
			# 			# how do we know that this succeeded?
			# 			# # this needs to take a filter func
			# 			@proxyvisor.apiBinder.patchDevice(device.deviceId, fieldsToUpdateOnAPI)
			# 	.then =>
			# 		@db.models('dependentDevice').update(fieldsToUpdateOnDB).where({ uuid })
			# 	.then =>
			# 		@db.models('dependentDevice').select().where({ uuid })
			# 	.then ([ device ]) ->
			# 		res.json(parseDeviceFields(device))
			# .catch (err) ->
			# 	console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
			# 	res.status(503).send(err?.message or err or 'Unknown error')

		# tested
		@router.post '/device/:uuid/log', (req, res) =>
			m =
				message: req.body.message
				timestamp: req.body.timestamp or Date.now()
				isSystem: req.body.isSystem if req.body.isSystem?

			@db.models('dependentDevice').select().where(_.pick(req.params, 'uuid')).
				orWhere _.mapKeys _.pick(req.params, 'uuid'), (value, key) ->
					'local_id'
			.then ([ device ]) =>
				return res.status(404).send('Device not found') if !device?
				return res.status(410).send('Device deleted') if device.markedForDeletion

				@logger.log(m, { channel: "device-#{device.logs_channel}-logs" })
				res.status(202).send('OK')
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')
