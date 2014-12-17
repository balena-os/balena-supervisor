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
		blinking = null
		start = (pattern) ->
			Promise.resolve([0...pattern.blinks]).cancellable()
			.each ->
				blink(pattern.onDuration)
				.delay(pattern.offDuration)
			.delay(pattern.pause)
			.then ->
				start(pattern)
		return {
			start: (pattern) ->
				return false if blinking?
				blinking = start(pattern)
				return
			stop: ->
				return false if not blinking?
				blinking.cancel().catch(Promise.CancellationError, ->)
				ledOff()
				blinking = null
		}

	return blink