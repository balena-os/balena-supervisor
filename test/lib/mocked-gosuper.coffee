express = require 'express'
_ = require 'lodash'
api = express()
api.use(require('body-parser').json())

api.gosuperBackend = {
	vpnControlHandler: (req, res) ->
		res.status(202).send({ Data: 'OK', Error: "" })
}

api.post '/v1/vpncontrol', (req, res) ->
	api.gosuperBackend.vpnControlHandler(req, res)

api.get '/v1/vpncontrol', (req, res) ->
	api.gosuperBackend.vpnControlHandler(req, res)

module.exports = api
