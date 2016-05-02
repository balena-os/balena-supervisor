Promise = require 'bluebird'
utils = require './utils'
express = require 'express'
bodyParser = require 'body-parser'
bufferEq = require 'buffer-equal-constant-time'
request = require 'request'
config = require './config'
device = require './device'
dockerUtils = require './docker-utils'
_ = require 'lodash'
compose = require './compose'
knex = require './db'

module.exports = (application) ->
	api = express()
	unparsedRouter = express.Router()
	parsedRouter = express.Router()
	parsedRouter.use(bodyParser())

	api.use (req, res, next) ->
		queryKey = req.query.apikey
		header = req.get('Authorization') ? ''
		match = header.match(/^ApiKey (\w+)$/)
		headerKey = match?[1]
		utils.getOrGenerateSecret('api')
		.then (secret) ->
			if queryKey? && bufferEq(new Buffer(queryKey), new Buffer(secret))
				next()
			else if headerKey? && bufferEq(new Buffer(headerKey), new Buffer(secret))
				next()
			else
				res.sendStatus(401)
		.catch (err) ->
			# This should never happen...
			res.status(503).send('Invalid API key in supervisor')

	unparsedRouter.get '/ping', (req, res) ->
		res.send('OK')

	unparsedRouter.post '/v1/blink', (req, res) ->
		utils.mixpanelTrack('Device blink')
		utils.blink.pattern.start()
		setTimeout(utils.blink.pattern.stop, 15000)
		res.sendStatus(200)

	parsedRouter.post '/v1/update', (req, res) ->
		utils.mixpanelTrack('Update notification')
		application.update(req.body.force)
		res.sendStatus(204)

	parsedRouter.post '/v1/reboot', (req, res) ->
		force = req.body.force
		utils.mixpanelTrack('Reboot')
		knex('app').select()
		.map (theApp) ->
			Promise.using application.lockUpdates(theApp.appId, force), ->
				# There's a slight chance the app changed after the previous select
				# So we fetch it again now the lock is acquired
				knex('app').select().where({ appId: theApp.appId })
				.then ([ app ]) ->
					application.kill(app, removeContainer: false) if app?
		.then ->
			new Promise (resolve, reject) ->
				request.post(config.gosuperAddress + '/v1/reboot')
				.on('error', reject)
				.on('response', -> resolve())
				.pipe(res)
		.catch (err) ->
			if err instanceof application.UpdatesLockedError
				status = 423
			else
				status = 500
			res.status(status).send(err?.message or err or 'Unknown error')

	parsedRouter.post '/v1/shutdown', (req, res) ->
		force = req.body.force
		utils.mixpanelTrack('Shutdown')
		knex('app').select()
		.map (theApp) ->
			Promise.using application.lockUpdates(theApp.appId, force), ->
				# There's a slight chance the app changed after the previous select
				# So we fetch it again now the lock is acquired
				knex('app').select().where({ appId: theApp.appId })
				.then ([ app ]) ->
					application.kill(app, removeContainer: false) if app?
		.then ->
			new Promise (resolve, reject) ->
				request.post(config.gosuperAddress + '/v1/shutdown')
				.on('error', reject)
				.on('response', -> resolve())
				.pipe(res)
		.catch (err) ->
			if err instanceof application.UpdatesLockedError
				status = 423
			else
				status = 500
			res.status(status).send(err?.message or err or 'Unknown error')

	parsedRouter.post '/v1/purge', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Purge /data', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId, true), ->
			utils.getKnexApp(appId)
			.then (app) ->
				application.kill(app)
				.then ->
					new Promise (resolve, reject) ->
						request.post(config.gosuperAddress + '/v1/purge', { json: true, body: applicationId: appId })
						.on('error', reject)
						.on('response', -> resolve())
						.pipe(res)
					.finally ->
						application.start(app)
		.catch utils.AppNotFoundError, (e) ->
			return res.status(400).send(e.message)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	unparsedRouter.post '/v1/tcp-ping', (req, res) ->
		utils.disableCheck(false)
		res.sendStatus(204)

	unparsedRouter.delete '/v1/tcp-ping', (req, res) ->
		utils.disableCheck(true)
		res.sendStatus(204)

	parsedRouter.post '/v1/restart', (req, res) ->
		appId = req.body.appId
		force = req.body.force
		utils.mixpanelTrack('Restart container', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId, force), ->
			utils.getKnexApp(appId)
			.then (app) ->
				application.kill(app)
				.then ->
					application.start(app)
		.then ->
			res.status(200).send('OK')
		.catch utils.AppNotFoundError, (e) ->
			return res.status(400).send(e.message)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	parsedRouter.post '/v1/apps/:appId/stop', (req, res) ->
		{ appId } = req.params
		{ force } = req.body
		utils.mixpanelTrack('Stop container', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId, force), ->
			utils.getKnexApp(appId)
			.tap (app) ->
				application.kill(app, removeContainer: false)
			.then (app) ->
				res.json(_.pick(app, 'containerId'))
		.catch utils.AppNotFoundError, (e) ->
			return res.status(400).send(e.message)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	unparsedRouter.post '/v1/apps/:appId/start', (req, res) ->
		{ appId } = req.params
		utils.mixpanelTrack('Start container', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId), ->
			utils.getKnexApp(appId)
			.tap (app) ->
				application.start(app)
			.then (app) ->
				res.json(_.pick(app, 'containerId'))
		.catch utils.AppNotFoundError, (e) ->
			return res.status(400).send(e.message)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	unparsedRouter.get '/v1/apps/:appId', (req, res) ->
		{ appId } = req.params
		utils.mixpanelTrack('GET app', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId, true), ->
			columns = [ 'appId', 'containerId', 'commit', 'imageId', 'env' ]
			utils.getKnexApp(appId, columns)
			.then (app) ->
				# Don't return keys on the endpoint
				app.env = _.omit(JSON.parse(app.env), config.privateAppEnvVars)
				# Don't return data that will be of no use to the user
				res.json(app)
		.catch utils.AppNotFoundError, (e) ->
			return res.status(400).send(e.message)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')


	# Expires the supervisor's API key and generates a new one.
	# It also communicates the new key to the Resin API.
	unparsedRouter.post '/v1/regenerate-api-key', (req, res) ->
		utils.newSecret('api')
		.then (secret) ->
			device.updateState(api_secret: secret)
			res.status(200).send(secret)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	unparsedRouter.get '/v1/device', (req, res) ->
		res.json(device.getState())

	unparsedRouter.post '/v1/images/create', dockerUtils.createImage
	unparsedRouter.post '/v1/images/load', dockerUtils.loadImage
	unparsedRouter.delete '/v1/images/*', dockerUtils.deleteImage
	unparsedRouter.get '/v1/images', dockerUtils.listImages
	parsedRouter.post '/v1/containers/create', dockerUtils.createContainer
	parsedRouter.post '/v1/containers/update', dockerUtils.updateContainer
	parsedRouter.post '/v1/containers/:id/start', dockerUtils.startContainer
	unparsedRouter.post '/v1/containers/:id/stop', dockerUtils.stopContainer
	unparsedRouter.delete '/v1/containers/:id', dockerUtils.deleteContainer
	unparsedRouter.get '/v1/containers', dockerUtils.listContainers

	unparsedRouter.post '/v1/apps/:appId/compose/up', (req, res) ->
		appId = req.params.appId
		onStatus = (status) ->
			status = JSON.stringify(status) if _.isObject(status)
			res.write(status)
		utils.getKnexApp(appId)
		.then (app) ->
			res.status(200)
			compose.up(appId, onStatus)
			.catch (err) ->
				console.log('Error on compose up:', err, err.stack)
			.finally ->
				res.end()
		.catch utils.AppNotFoundError, (e) ->
			return res.status(400).send(e.message)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	unparsedRouter.post '/v1/apps/:appId/compose/down', (req, res) ->
		appId = req.params.appId
		onStatus = (status) ->
			status = JSON.stringify(status) if _.isObject(status)
			res.write(status)
		utils.getKnexApp(appId)
		.then (app) ->
			res.status(200)
			compose.down(appId, onStatus)
			.catch (err) ->
				console.log('Error on compose down:', err, err.stack)
			.finally ->
				res.end()
		.catch utils.AppNotFoundError, (e) ->
			return res.status(400).send(e.message)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	api.use(unparsedRouter)
	api.use(parsedRouter)

	return api
