Promise = require 'bluebird'
utils = require './utils'
express = require 'express'
bodyParser = require 'body-parser'
bufferEq = require 'buffer-equal-constant-time'
config = require './config'
device = require './device'
_ = require 'lodash'
proxyvisor = require './proxyvisor'
hostConfig = require './host-config'

module.exports = (application) ->
	authenticate = (req, res, next) ->
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
			else if application.localMode
				next()
			else
				res.sendStatus(401)
		.catch (err) ->
			# This should never happen...
			res.status(503).send('Invalid API key in supervisor')

	api = express()
	unparsedRouter = express.Router()
	parsedRouter = express.Router()
	unauthenticatedRouter = express.Router()

	parsedRouter.use(bodyParser())
	parsedRouter.use(authenticate)
	unparsedRouter.use(authenticate)

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
		Promise.map utils.getKnexApps(), (theApp) ->
			Promise.using application.lockUpdates(theApp.appId, force), ->
				# There's a slight chance the app changed after the previous select
				# So we fetch it again now the lock is acquired
				utils.getKnexApp(theApp.appId)
				.then (app) ->
					application.kill(app, removeContainer: false) if app?
		.then ->
			application.logSystemMessage('Rebooting', {}, 'Reboot')
			device.reboot()
			.then (response) ->
				res.status(202).json(response)
		.catch (err) ->
			if err instanceof application.UpdatesLockedError
				status = 423
			else
				status = 500
			res.status(status).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	parsedRouter.post '/v1/shutdown', (req, res) ->
		force = req.body.force
		Promise.map utils.getKnexApps(), (theApp) ->
			Promise.using application.lockUpdates(theApp.appId, force), ->
				# There's a slight chance the app changed after the previous select
				# So we fetch it again now the lock is acquired
				utils.getKnexApp(theApp.appId)
				.then (app) ->
					application.kill(app, removeContainer: false) if app?
		.then ->
			application.logSystemMessage('Shutting down', {}, 'Shutdown')
			device.shutdown()
			.then (response) ->
				res.status(202).json(response)
		.catch (err) ->
			if err instanceof application.UpdatesLockedError
				status = 423
			else
				status = 500
			res.status(status).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	parsedRouter.post '/v1/purge', (req, res) ->
		appId = req.body.appId
		application.logSystemMessage('Purging /data', { appId }, 'Purge /data')
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId, true), ->
			utils.getKnexApp(appId)
			.then (app) ->
				application.kill(app)
				.then ->
					new Promise (resolve, reject) ->
						utils.gosuper.post('/v1/purge', { json: true, body: applicationId: appId })
						.on('error', reject)
						.on('response', -> resolve())
						.pipe(res)
					.then ->
						application.logSystemMessage('Purged /data', { appId }, 'Purge /data success')
					.finally ->
						application.start(app)
		.catch (err) ->
			status = 503
			if err instanceof utils.AppNotFoundError
				errMsg = "App not found: an app needs to be installed for purge to work.
					If you've recently moved this device from another app,
					please push an app and wait for it to be installed first."
				err = new Error(errMsg)
				status = 400
			application.logSystemMessage("Error purging /data: #{err}", { appId, error: err }, 'Purge /data error')
			res.status(status).send(err?.message or err or 'Unknown error')

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
			.then (app) ->
				application.getContainerId(app)
				.then (containerId) ->
					application.kill(app, removeContainer: false)
					.then (app) ->
						res.json({ containerId })
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
				.then ->
					application.getContainerId(app)
				.then (containerId) ->
					res.json({ containerId })
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
			columns = [ 'appId', 'containerName', 'commit', 'imageId', 'env' ]
			utils.getKnexApp(appId, columns)
			.then (app) ->
				application.getContainerId(app)
				.then (containerId) ->
					# Don't return keys on the endpoint
					app.env = _.omit(JSON.parse(app.env), config.privateAppEnvVars)
					app.containerId = containerId
					# Don't return data that will be of no use to the user
					res.json(_.omit(app, [ 'containerName' ]))
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

	parsedRouter.get '/v1/device/host-config', (req, res) ->
		hostConfig.get()
		.then (conf) ->
			res.json(conf)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	parsedRouter.patch '/v1/device/host-config', (req, res) ->
		hostConfig.patch(req.body)
		.then ->
			res.status(200).send('OK')
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	unparsedRouter.get '/v1/device', (req, res) ->
		res.json(device.getState())

	unauthenticatedRouter.get '/v1/healthy', (req, res) ->
		# Has the update cycle not hung? (unless we're downloading an image)
		healthy = application.healthy()
		# If we're connected and we know it, has the current state been reported?
		healthy and= device.stateReportHealthy()
		# As far as we know, is gosuper healthy?
		healthy and= device.gosuperHealthy()

		if healthy
			res.sendStatus(200)
		else
			res.sendStatus(500)

	api.use(unauthenticatedRouter)
	api.use(unparsedRouter)
	api.use(parsedRouter)
	api.use(proxyvisor.router)

	return api
