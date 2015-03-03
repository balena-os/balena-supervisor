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
			res.send(401)

	api.post '/v1/blink', (req, res) ->
		utils.mixpanelTrack('Device blink')
		utils.blink.pattern.start()
		setTimeout(utils.blink.pattern.stop, 15000)
		res.send(200)

	api.post '/v1/update', (req, res) ->
		utils.mixpanelTrack('Update notification')
		application.update()
		res.send(204)

	api.post '/v1/spawn-tty', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Spawn tty', appId)
		if !appId?
			res.send(400, 'Missing app id')
		knex('app').select().where({appId})
		.then ([ app ]) ->
			if !app?
				throw new Error('App not found')
			tty.start(app)
		.then (url) ->
			res.send(200, url)
		.catch (err) ->
			res.send(503, err?.message or err or 'Unknown error')

	api.post '/v1/despawn-tty', (req, res) ->
		appId = req.body.appId
		utils.mixpanelTrack('Despawn tty', appId)
		if !appId?
			res.send(400, 'Missing app id')
		tty.stop(appId)
		.then ->
			res.send(200)
		.catch (err) ->
			res.send(503, err?.message or err or 'Unknown error')

	return api
