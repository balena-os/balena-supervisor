Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
url = require 'url'
{
	isDefined,
	parseDeviceFields,
	validStringOrUndefined,
	validObjectOrUndefined,
	tarPath,
	getTarArchive,
} = require './utils'

module.exports = class ProxyvisorRouterV1
	constructor: (@proxyvisor) ->
		{ @config, @logger, @db, @docker, @reportCurrentState } = @proxyvisor
		@router = express.Router()

		@router.get '/devices', (req, res) =>
			@db.models('dependentDevice').select()
			.map(parseDeviceFields)
			.then (devices) ->
				res.json(devices)
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.post '/devices', (req, res) =>
			{ appId, device_type } = req.body

			if !appId? or _.isNaN(parseInt(appId)) or parseInt(appId) <= 0
				res.status(400).send('appId must be a positive integer')
				return
			device_type = 'generic' if !device_type?
			d =
				application: req.body.appId
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

		@router.get '/devices/:uuid', (req, res) =>
			uuid = req.params.uuid
			@db.models('dependentDevice').select().where({ uuid })
			.then ([ device ]) ->
				return res.status(404).send('Device not found') if !device?
				return res.status(410).send('Device deleted') if device.markedForDeletion
				res.json(parseDeviceFields(device))
			.catch (err) ->
				console.error("Error on #{req.method} #{url.parse(req.url).pathname}", err, err.stack)
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.post '/devices/:uuid/logs', (req, res) =>
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

		@router.put '/devices/:uuid', (req, res) =>
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

		@router.get '/dependent-apps/:appId/assets/:commit', (req, res) =>
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

		@router.get '/dependent-apps', (req, res) =>
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
