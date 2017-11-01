m = require 'mochainon'
{ expect } = m.chai
{ spy, useFakeTimers } = m.sinon

Logger = require '../src/logger'

describe 'Logger', ->
	before ->
		@fakeBinder = {
			logBatch: spy()
		}
		@fakeEventTracker = {
			track: spy()
		}
		@logger = new Logger({ eventTracker: @fakeEventTracker })
		@logger.init({ pubnub: {}, channel: 'foo', offlineMode: 'false', enable: 'true', nativeLogger: 'true', apiBinder: @fakeBinder })

	after ->
		@logger.stop()

	it 'publishes logs to the resin API by default', (done) ->
		theTime = Date.now()
		@logger.log(message: 'Hello!', timestamp: theTime)
		setTimeout( =>
			expect(@fakeBinder.logBatch).to.be.calledWith([ { message: 'Hello!', timestamp: theTime } ])
			@fakeBinder.logBatch.reset()
			done()
		, 1020)

	it 'allows logging system messages which are also reported to the eventTracker', (done) ->
		clock = useFakeTimers()
		clock.tick(10)
		@logger.logSystemMessage('Hello there!', { someProp: 'someVal' }, 'Some event name')
		clock.restore()
		setTimeout( =>
			expect(@fakeBinder.logBatch).to.be.calledWith([ { message: 'Hello there!', timestamp: 10, isSystem: true } ])
			expect(@fakeEventTracker.track).to.be.calledWith('Some event name', { someProp: 'someVal' })
			done()
		, 1020)
