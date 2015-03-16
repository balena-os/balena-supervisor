Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
utils = require './utils'
application = require './application'
tty = require './lib/tty'
knex = require './db'
express = require 'express'
bodyParser = require 'body-parser'

module.exports = (secret) ->
	api = express()
	api.use(bodyParser())
	api.use (req, res, next) ->
		if req.query.apikey is secret
			next()
		else
			res.sendStatus(401)

	api.post '/v1/blink', (req, res) ->
		utils.mixpanelTrack('Device blink')
		utils.blink.pattern.start()
		setTimeout(utils.blink.pattern.stop, 15000)
		res.sendStatus(200)

	api.post '/v1/update', (req, res) ->
		utils.mixpanelTrack('Update notification')
		application.update()
		res.sendStatus(204)

	api.post '/v1/spawn-tty', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Spawn tty', appId)
		if !appId?
			res.status(400).send('Missing app id')
		knex('app').select().where({appId})
		.then ([ app ]) ->
			if !app?
				throw new Error('App not found')
			tty.start(app)
		.then (url) ->
			res.status(200).send(url)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	api.post '/v1/despawn-tty', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Despawn tty', appId)
		if !appId?
			res.status(400).send('Missing app id')
		knex('app').select().where({appId})
		.then ([ app ]) ->
			if !app?
				throw new Error('App not found')
			tty.stop(app)
		.then ->
			res.sendStatus(200)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	return api
