Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
url = require 'url'
knex = require './db'
utils = require './utils'
express = require 'express'
request = Promise.promisify require 'request'

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
	res.send(204)
	Promise.all([
		knex('config').select('value').where(key: 'apiKey')
		knex('config').select('value').where(key: 'uuid')
	]).then(([[apiKey], [uuid]]) ->
		apiKey = apiKey.value
		uuid = uuid.value
		request(
			method: 'GET'
			url: url.resolve(process.env.API_ENDPOINT, "/ewa/application?$filter=device/uuid eq '#{uuid}'&apikey=#{apiKey}")
			json: true
		).spread((request, body) ->
			for app in body.d
				console.log("Got application", app)
		)
	)
)

module.exports = api
