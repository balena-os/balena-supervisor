m = require 'mochainon'
_ = require 'lodash'
PUBNUB = require 'pubnub'

{ expect } = m.chai
{ stub, spy, useFakeTimers } = m.sinon

Logger = require '../src/logger'

describe 'Logger', ->
	before ->
		@fakePubnub = {
			publish: spy()
		}
		@fakeEventTracker = {
			track: spy()
		}
		stub(PUBNUB, 'init').returns(@fakePubnub)
		@logger = new Logger({ eventTracker: @fakeEventTracker })
		@logger.init({ pubnub: {}, channel: 'foo', offlineMode: 'false', enable: 'true' })

	after ->
		PUBNUB.init.restore()

	it 'publishes logs to pubnub', (done) ->
		theTime = Date.now()
		@logger.log(m: 'Hello!', t: theTime)	
		setTimeout( => 
			expect(@fakePubnub.publish).to.be.calledWith({ channel: 'foo', message: [ { m: 'Hello!', t: theTime } ] })
			@fakePubnub.publish.reset()
			done()
		, 220)

	it 'allows logging system messages which are also reported to the eventTracker', (done) ->
		clock = useFakeTimers()
		clock.tick(10)
		@logger.logSystemMessage('Hello there!', { someProp: 'someVal' }, 'Some event name')
		clock.restore()
		setTimeout( =>
			expect(@fakePubnub.publish).to.be.calledWith({ channel: 'foo', message: [ { m: 'Hello there!', t: 10, s: 1 } ] })
			expect(@fakeEventTracker.track).to.be.calledWith('Some event name', { someProp: 'someVal' })
			done()
		, 220)
