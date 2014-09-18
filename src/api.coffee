Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
utils = require './utils'
express = require 'express'
application = require './application'
supervisor = require './supervisor-update'
tty = require './tty'

api = express()
api.use(express.bodyParser())

api.post '/v1/blink', (req, res) ->
	utils.mixpanelTrack('Device blink')
	interval = setInterval(utils.blink, 400)
	setTimeout(->
		clearInterval(interval)
	, 15000)
	res.send(200)

api.post '/v1/update', (req, res) ->
	utils.mixpanelTrack('Update notification')
	application.update()
	res.send(204)

api.post '/v1/update-supervisor', (req, res) ->
	console.log('Got supervisor update')
	supervisor.update()
	res.send(204)

api.post '/v1/spawn-tty', (req, res) ->
	appId = req.body.appId
	utils.mixpanelTrack('Spawn tty', appId)
	if !appId?
		res.send(400, 'Missing app id')
	tty.start(appId)
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
		res.send(404, err)

module.exports = api
