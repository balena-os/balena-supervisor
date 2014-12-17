Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'

# Helps in blinking the LED from the given end point.
module.exports = exports = (ledFile) ->
	blink = (ms = 200) ->
		fs.writeFileAsync(ledFile, 1)
		.delay(ms)
		.then -> fs.writeFileAsync(ledFile, 0)

	blink.pattern = do ->
		started = false
		interval = null
		timeout = null
		# This function lets us have sensible param orders,
		# and always have a timeout we can cancel.
		delay = (ms, fn) ->
			timeout = setTimeout(fn, ms)
		start = ->
			interval = setInterval(blink, 400)
			delay 2000, ->
				# Clear the blinks after 2 second
				clearInterval(interval)
				delay 2000, ->
					# And then repeat again after another 2 seconds
					start()
		return {
			start: ->
				return false if started
				started = true
				start()
			stop: ->
				return false if not started
				started = false
				clearInterval(interval)
				clearTimeout(timeout)
		}

	return blink