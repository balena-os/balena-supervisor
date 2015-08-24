Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
utils = require './utils'
application = require './application'
tty = require './lib/tty'
knex = require './db'
express = require 'express'
bodyParser = require 'body-parser'
request = require 'request'
config = require './config'

module.exports = (secret) ->
	api = express()
	api.use(bodyParser())
	api.use (req, res, next) ->
		if req.query.apikey is secret
			next()
		else
			res.sendStatus(401)

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
		.then ({url}) ->
			res.status(200).send(url)
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
						request.post(config.gosuperAddress + '/v1/purge', { json: true, body: applicationId: appId.toString() })
						.on 'error', reject
						.on 'response', -> resolve()
						.pipe(res)
					.finally ->
						application.start(app)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	api.post '/tcp-ping', (req, res) ->
		utils.disableCheck(false)
		res.sendStatus(204)

	api.delete '/tcp-ping', (req, res) ->
		utils.disableCheck(true)
		res.sendStatus(204)

	return api
