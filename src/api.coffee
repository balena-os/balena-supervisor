Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
utils = require './utils'
express = require 'express'
dockerode = require 'dockerode'

api = express()

LED_FILE = '/sys/class/leds/led0/brightness'

blink = (ms = 200) ->
	fs.writeFileAsync(LED_FILE, 1)
		.then(-> utils.delay(ms))
		.then(-> fs.writeFileAsync(LED_FILE, 0))

api.post('/v1/blink', (req, res) ->
	interval = setInterval(blink, 400)
	setTimeout(->
		clearInterval(interval)
	, 5000)
	res.send(200)
)

api.post('/v1/update', (req, res) ->
	console.log('TODO: Update the application')
)

module.exports = api
