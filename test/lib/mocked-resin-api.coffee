express = require 'express'
api = express()
api.use(require('body-parser').json())

currentId = 1
devices = {}

api.registerHandler = (req, res) ->
	console.log('/device/register called with ', req.body)
	device = req.body
	device.id = currentId++
	devices[device.id] = device
	res.status(201).json(device)

api.post '/device/register', (req, res) ->
	api.registerHandler(req, res)

module.exports = api