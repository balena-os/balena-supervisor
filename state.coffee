settings = require('./settings')
fs = require('fs')

sync = (data) ->
	fs.writeFileSync(settings.STATE_FILE, JSON.stringify(data))

if not fs.existsSync(settings.STATE_FILE)
	sync({})
	
state = require(settings.STATE_FILE)

exports.get = (key) -> state[key]

exports.set = (key, value) ->
	state[key] = value
	sync(state)
