express = require 'express'
_ = require 'lodash'
api = express()
api.use(require('body-parser').json())

api.balenaBackend = {
	currentId: 1
	devices: {}
	registerHandler: (req, res) ->
		console.log('/device/register called with ', req.body)
		device = req.body
		device.id = api.balenaBackend.currentId++
		api.balenaBackend.devices[device.id] = device
		res.status(201).json(device)
	getDeviceHandler: (req, res) ->
		uuid = req.query['$filter']?.match(/uuid eq '(.*)'/)?[1]
		if uuid?
			res.json({ d: _.filter(api.balenaBackend.devices, (dev) -> dev.uuid is uuid ) })
		else
			res.json({ d: [] })
	deviceKeyHandler: (req, res) ->
		res.status(200).send(req.body.apiKey)
}


api.post '/device/register', (req, res) ->
	api.balenaBackend.registerHandler(req, res)

api.get '/v5/device', (req, res) ->
	api.balenaBackend.getDeviceHandler(req, res)

api.post '/api-key/device/:deviceId/device-key', (req, res) ->
	api.balenaBackend.deviceKeyHandler(req, res)

module.exports = api
