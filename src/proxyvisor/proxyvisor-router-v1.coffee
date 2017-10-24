Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
url = require 'url'
Lock = require 'rwlock'
{
	isDefined,
	parseDeviceFields,
	parseApplicationFields,
	validStringOrUndefined,
	validObjectOrUndefined,
	validNumberOrUndefined,
	tarPath,
	getTarArchive,
} = require './utils'

module.exports = class ProxyvisorRouterV2
	constructor: (@proxyvisor) ->
		{ @config, @logger, @db, @docker, @reportCurrentState } = @proxyvisor

		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)

		@router = express.Router()

		@router.get '/application', (req, res) =>
			@db.models('dependentApp').select()
			.map (parseApplicationFields)
			.then (apps) ->
				res.json(apps)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

		@router.get '/application/:appId', (req, res) =>
			@db.models('dependentApp').select().where(_.pick(req.params, 'appId'))
			.then ([ app ]) ->
				return res.status(404).send('Application not found') if !app?

				res.json(parseApplicationFields(app))
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

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

		# TODO figure out why this still returns the contents of /asset rather than
		# the complete docker image
		@router.get '/application/:appId/update/image/:commit', (req, res) =>
			@db.models('dependentApp').select().where(_.pick(req.params, 'appId', 'commit'))
			.then ([ app ]) ->
				return res.status(404).send('Application not found') if !app?
				return res.status(404).send('Commit not found') if !app.commit?

				dest = tarPath(app.appId, app.commit)
				fs.lstatAsync(dest)
				.catch =>
					stream = fs.createWriteStream(dest)
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

		@router.post '/application/:appId/scan', (req, res) =>
			{ appId } = req.params
			{ device_type, online_devices, expiry_date } = req.body
			if !appId? or _.isNaN(parseInt(appId)) or parseInt(appId) <= 0
				return res.status(400).send('appId not found')
			if !device_type? or _.isEmpty(device_type) or !_.isString(device_type)
				return res.status(400).send('device_type not found')
			if !online_devices? or !_.isArray(online_devices)
				return res.status(400).send('online_devices not found')
			if !expiry_date? or _.isNaN(parseInt(expiry_date)) or parseInt(expiry_date) <= 0
				return res.status(400).send('expiry_date not found')

			@proxyvisor.apiBinder.sendOnlineDependentDevices(appId, device_type, online_devices, expiry_date)
			.then =>
				@db.models('dependentDevice').select('uuid').whereNotIn('local_id', online_devices).andWhere({ appId })
			.then (devices) ->
				_.map(devices, 'uuid')
			.then (devices) =>
				# TODO: currently returns `res.send()` before the code block below has finished executing.
				# It should not return until the code block has finished executing
				if !_.isEmpty(devices)
					Promise.using @_lockGetTarget(), =>
						Promise.all([
							@db.models('dependentDevice').del().whereIn('uuid', devices)
							@db.models('dependentDeviceTarget').del().whereIn('uuid', devices)
						])
			.then ->
				res.send()
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack) if err.code == 500
				res.status(err.code).send(err?.message or err or 'Unknown error')

		@router.get '/device', (req, res) =>
			@db.models('dependentDevice').select().where(_.pick(req.query, 'appId'))
			.map(parseDeviceFields)
			.then (devices) ->
				res.json(devices)
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

		@router.get '/device/:uuid', (req, res) =>
			@db.models('dependentDevice').select().where(_.pick(req.params, 'uuid')).
				orWhere _.mapKeys _.pick(req.params, 'uuid'), (value, key) ->
					'local_id'
			.then ([ device ]) ->
				return res.status(404).send('Device not found') if !device?

				res.json(parseDeviceFields(device))
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

		@router.patch '/device/:uuid', (req, res) =>
			{ status, commit, environment, config, download_progress } = req.body
			if !validStringOrUndefined(status)
				return res.status(400).send('status must be a non-empty string')
			if !validStringOrUndefined(commit)
				return res.status(400).send('commit must be a non-empty string')
			if !validObjectOrUndefined(environment)
				return res.status(400).send('environment must be an object')
			if !validObjectOrUndefined(config)
				return res.status(400).send('config must be an object')
			if !validNumberOrUndefined(download_progress)
				return res.status(400).send('download_progress must be an integer')

			environment = JSON.stringify(environment) if isDefined(environment)
			config = JSON.stringify(config) if isDefined(config)

			fieldsToUpdateOnDB = _.pickBy({ status, commit, environment, config, download_progress }, isDefined)

			fieldsToUpdateOnAPI = _.pick(fieldsToUpdateOnDB, 'status', 'commit', 'config', 'environment', 'download_progress')

			return res.status(400).send('At least one device attribute must be updated') if _.isEmpty(fieldsToUpdateOnDB)

			@db.models('dependentDevice').select().where(_.pick(req.params, 'uuid')).
				orWhere _.mapKeys _.pick(req.params, 'uuid'), (value, key) ->
					'local_id'
			.then ([ device ]) =>
				return res.status(404).send('Device not found') if !device?
				throw new Error('Device is invalid') if !device.deviceId?

				uuid = device.uuid
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

				console.log('logs channel: ', JSON.stringify(device.logs_channel))
				@logger.log(m, { channel: "device-#{device.logs_channel}-logs" })
				res.status(202).send()
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(500).send(err?.message or err or 'Unknown error')

	_lockGetTarget: =>
		@_writeLock('getTarget').disposer (release) ->
			release()
