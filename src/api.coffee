Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
utils = require './utils'
express = require 'express'
application = require './application'
supervisor = require './supervisor-update'

api = express()

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

module.exports = api
