fs = require 'fs'
express = require 'express'
dockerode = require 'dockerode'

api = express()

LED_FILE = '/sys/class/leds/led0/brightness'
blink = (ms = 200, callback) ->
	fs.writeFileSync(LED_FILE, 1)
	setTimeout(->
		fs.writeFile(LED_FILE, 0, callback)
	, ms)

api.post('/blink', (req, res) ->
	interval = setInterval(blink, 400)
	setTimeout(->
		clearInterval(interval)
	, 5000)
	res.send(200)
)

api.post('/update', (req, res) ->
	console.log('TODO: Update the application')
)

module.exports = api
