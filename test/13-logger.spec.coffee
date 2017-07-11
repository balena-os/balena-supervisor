m = require 'mochainon'
_ = require 'lodash'
PUBNUB = require 'pubnub'

{ expect } = m.chai
{ stub, spy } = m.sinon

Logger = require '../src/logger'

describe 'Logger', ->
	before ->
		@fakePubnub = {
			publish: spy()
		}
		stub(PUBNUB, 'init').returns(@fakePubnub)
		@logger = new Logger()
		@logger.init({ pubnub: {}, channel: 'foo', offlineMode: 'false', enable: 'true' })

	it 'publishes logs to pubnub', (done) ->
		theTime = Date.now()
		@logger.log(m: 'Hello!', t: theTime)	
		setTimeout( => 
			expect(@fakePubnub.publish).to.be.calledWith({ channel: 'foo', message: [ { m: 'Hello!', t: theTime } ] })
			done()
		, 220)
