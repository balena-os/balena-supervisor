Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
utils = require './utils'
tty = require './lib/tty'
knex = require './db'
express = require 'express'
bodyParser = require 'body-parser'
request = require 'request'
config = require './config'
device = require './device'

module.exports = (application) ->
	api = express()
	api.use(bodyParser())
	api.use (req, res, next) ->
		utils.getOrGenerateSecret('api')
		.then (secret) ->
			if req.query.apikey is secret
				next()
			else
				res.sendStatus(401)
		.catch (err) ->
			# This should never happen...
			res.status(503).send('Invalid API key in supervisor')

	api.get '/ping', (req, res) ->
		res.send('OK')

	api.post '/v1/blink', (req, res) ->
		utils.mixpanelTrack('Device blink')
		utils.blink.pattern.start()
		setTimeout(utils.blink.pattern.stop, 15000)
		res.sendStatus(200)

	api.post '/v1/update', (req, res) ->
		utils.mixpanelTrack('Update notification')
		application.update(req.body.force)
		res.sendStatus(204)

	api.post '/v1/spawn-tty', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Spawn tty', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		knex('app').select().where({ appId })
		.then ([ app ]) ->
			if !app?
				throw new Error('App not found')
			tty.start(app)
		.then ->
			res.sendStatus(200)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	api.post '/v1/despawn-tty', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Despawn tty', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		knex('app').select().where({ appId })
		.then ([ app ]) ->
			if !app?
				throw new Error('App not found')
			tty.stop(app)
		.then ->
			res.sendStatus(200)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	api.post '/v1/reboot', (req, res) ->
		utils.mixpanelTrack('Reboot')
		request.post(config.gosuperAddress + '/v1/reboot')
		.pipe(res)

	api.post '/v1/shutdown', (req, res) ->
		utils.mixpanelTrack('Shutdown')
		request.post(config.gosuperAddress + '/v1/shutdown')
		.pipe(res)

	api.post '/v1/purge', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Purge /data', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId, true), ->
			knex('app').select().where({ appId })
			.then ([ app ]) ->
				if !app?
					throw new Error('App not found')
				application.kill(app)
				.then ->
					new Promise (resolve, reject) ->
						request.post(config.gosuperAddress + '/v1/purge', { json: true, body: applicationId: appId })
						.on 'error', reject
						.on 'response', -> resolve()
						.pipe(res)
					.finally ->
						application.start(app)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	api.post '/v1/tcp-ping', (req, res) ->
		utils.disableCheck(false)
		res.sendStatus(204)

	api.delete '/v1/tcp-ping', (req, res) ->
		utils.disableCheck(true)
		res.sendStatus(204)

	api.post '/v1/restart', (req, res) ->
		appId = req.body.appId
		force = req.body.force
		utils.mixpanelTrack('Restart container', appId)
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.using application.lockUpdates(appId, force), ->
			knex('app').select().where({ appId })
			.then ([ app ]) ->
				if !app?
					throw new Error('App not found')
				application.kill(app)
				.then ->
					application.start(app)
		.then ->
			res.status(200).send('OK')
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	# Expires the supervisor's API key and generates a new one.
	# It also communicates the new key to the Resin API.
	api.post '/v1/regenerate-api-key', (req, res) ->
		utils.newSecret('api')
		.then (secret) ->
			device.updateState(api_secret: secret)
			res.status(200).send(secret)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	api.get '/v1/device', (req, res) ->
		res.json(device.getState())

	return api
