Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'

# Helps in blinking the LED from the given end point.
module.exports = exports = (ledFile) ->
	ledOn = ->
		fs.writeFileAsync(ledFile, 1)
	ledOff = ->
		fs.writeFileAsync(ledFile, 0)

	blink = (ms = 200) ->
		ledOn()
		.delay(ms)
		.then(ledOff)

	blink.pattern = do ->
		pattern =
			onDuration: 200
			offDuration: 200
			blinks: 4
			pause: 1000
		blinking = null
		start = ->
			Promise.resolve([0...pattern.blinks]).cancellable()
			.each ->
				blink(pattern.onDuration)
				.delay(pattern.offDuration)
			.delay(pattern.pause)
			.then ->
				start()
		return {
			start: ->
				return false if blinking?
				blinking = start()
				return
			stop: ->
				return false if not blinking?
				blinking.cancel().catch(Promise.CancellationError, ->)
				ledOff()
				blinking = null
		}

	return blink