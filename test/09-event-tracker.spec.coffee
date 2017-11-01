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
		@eventTrackerOffline.track('Test event', { appId: 'someValue' })
		expect(@eventTrackerOffline._logEvent).to.be.calledWith('Event:', 'Test event', JSON.stringify({ appId: 'someValue' }))

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
		@eventTracker.track('Test event 2', { appId: 'someOtherValue' })
		expect(@eventTracker._logEvent).to.be.calledWith('Event:', 'Test event 2', JSON.stringify({ appId: 'someOtherValue' }))
		expect(@eventTracker._client.track).to.be.calledWith('Test event 2', { appId: 'someOtherValue', uuid: 'barbaz', distinct_id: 'barbaz' })

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

	it 'hides service environment variables, to avoid logging keys or secrets', ->
		props = {
			service:
				appId: '1'
				environment: {
					RESIN_API_KEY: 'foo'
					RESIN_SUPERVISOR_API_KEY: 'bar'
					OTHER_VAR: 'hi'
				}
		}
		@eventTracker.track('Some app event', props)
		expect(@eventTracker._client.track).to.be.calledWith('Some app event', {
			service: { appId: '1' }
			uuid: 'barbaz'
			distinct_id: 'barbaz'
		})
