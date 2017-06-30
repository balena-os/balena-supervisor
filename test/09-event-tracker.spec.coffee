m = require 'mochainon'
mixpanel = require 'mixpanel'

{ expect } = m.chai
{ stub, spy } = m.sinon

EventTracker = require '../src/event-tracker'
describe 'EventTracker', ->
	before ->
		stub(mixpanel, 'init').callsFake (token) ->
			return {
				token: token
				track: stub().returns()
			}

		@eventTrackerOffline = new EventTracker()
		@eventTracker = new EventTracker()
		stub(EventTracker.prototype, '_logEvent')

	after ->
		EventTracker.prototype._logEvent.restore()
		mixpanel.init.restore()

	it 'initializes in offline mode', ->
		promise = @eventTrackerOffline.init({
			offlineMode: true
			uuid: 'foobar'
		})
		expect(promise).to.be.fulfilled
		.then =>
			expect(@eventTrackerOffline._client).to.be.null

	it 'logs events in offline mode, with the correct properties', ->
		@eventTrackerOffline.track('Test event', { someProp: 'someValue' })
		expect(@eventTrackerOffline._logEvent).to.be.calledWith('Event:', 'Test event', JSON.stringify({ someProp: 'someValue' }))

	it 'initializes a mixpanel client when not in offline mode', ->
		promise = @eventTracker.init({
			mixpanelToken: 'someToken'
			uuid: 'barbaz'
		})
		expect(promise).to.be.fulfilled
		.then =>
			expect(mixpanel.init).to.have.been.calledWith('someToken')
			expect(@eventTracker._client.token).to.equal('someToken')
			expect(@eventTracker._client.track).to.be.a('function')

	it 'calls the mixpanel client track function with the event, properties and uuid as distinct_id', ->
		@eventTracker.track('Test event 2', { someOtherProp: 'someOtherValue' })
		expect(@eventTracker._logEvent).to.be.calledWith('Event:', 'Test event 2', JSON.stringify({ someOtherProp: 'someOtherValue' }))
		expect(@eventTracker._client.track).to.be.calledWith('Test event 2', { someOtherProp: 'someOtherValue', uuid: 'barbaz', distinct_id: 'barbaz' })

	it 'can be passed an Error and it is added to the event properties', ->
		theError = new Error('something went wrong')
		@eventTracker.track('Error event', theError)
		expect(@eventTracker._client.track).to.be.calledWith('Error event', {
			error:
				message: theError.message
				stack: theError.stack
			uuid: 'barbaz'
			distinct_id: 'barbaz'
		})

	it 'omits RESIN_API_KEY or RESIN_SUPERVISOR_API_KEY env vars in the event properties', ->
		props = {
			app:
				env: JSON.stringify({
					RESIN_API_KEY: 'foo'
					RESIN_SUPERVISOR_API_KEY: 'bar'
					OTHER_VAR: 'hi'
				})
		}
		@eventTracker.track('Some app event', props)
		expect(@eventTracker._client.track).to.be.calledWith('Some app event', {
			app:
				env: JSON.stringify({ OTHER_VAR: 'hi' })
			uuid: 'barbaz'
			distinct_id: 'barbaz'
		})

	it 'makes the app env an empty object if it is invalid, to avoid accidentally logging private values', ->
		props = {
			app:
				env: '{this is invalid JSON'
		}
		@eventTracker.track('Some app event', props)
		expect(@eventTracker._client.track).to.be.calledWith('Some app event', {
			app:
				env: JSON.stringify({})
			uuid: 'barbaz'
			distinct_id: 'barbaz'
		})