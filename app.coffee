express = require('express')
async = require('async')
bootstrap = require('./bootstrap')
state = require('./state')
settings = require('./settings')

tasks = [
	(callback) ->
		if state.get('virgin')
			handler = (error) ->
				if error
					setTimeout(-> bootstrap(handler), 10000)
				else
					state.set('virgin', false)
					callback()
			bootstrap(handler)
		else
			callback()
	# (callback) ->
]

async.series(tasks, (error) ->
	if error
		console.error(error)
)

app = express()

app.post('/blink', (req, res) ->
	state = 0
	toggleLed = ->
		state = (state + 1) % 2
		fs.writeFileSync(settings.LED_FILE, state)

	interval = setInterval(toggleLed, settings.BLINK_STEP)
	setTimeout(->
		clearInterval(interval)
		res.send(200)
	, 5000)
)

app.post('/update', (req, res) ->


)

app.listen(80)
