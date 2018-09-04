mixpanel = require 'mixpanel'

m = require 'mochainon'
{ expect } = m.chai
{ stub } = m.sinon

supervisorVersion = require '../src/lib/supervisor-version'

{ EventTracker } = require '../src/event-tracker'
describe 'EventTracker', ->
	before ->
		stub(mixpanel, 'init').callsFake (token) ->
			return {
				token: token
				track: stub().returns()
			}

		@eventTrackerOffline = new EventTracker()
		@eventTracker = new EventTracker()
		stub(EventTracker.prototype, 'logEvent')

	after ->
		EventTracker.prototype.logEvent.restore()
		mixpanel.init.restore()

	it 'initializes in offline mode', ->
		promise = @eventTrackerOffline.init({
			offlineMode: true
			uuid: 'foobar'
		})
		expect(promise).to.be.fulfilled
		.then =>
			expect(@eventTrackerOffline.client).to.be.null

	it 'logs events in offline mode, with the correct properties', ->
		@eventTrackerOffline.track('Test event', { appId: 'someValue' })
		expect(@eventTrackerOffline.logEvent).to.be.calledWith('Event:', 'Test event', JSON.stringify({ appId: 'someValue' }))

	it 'initializes a mixpanel client when not in offline mode', ->
		promise = @eventTracker.init({
			mixpanelToken: 'someToken'
			uuid: 'barbaz'
		})
		expect(promise).to.be.fulfilled
		.then =>
			expect(mixpanel.init).to.have.been.calledWith('someToken')
			expect(@eventTracker.client.token).to.equal('someToken')
			expect(@eventTracker.client.track).to.be.a('function')

	it 'calls the mixpanel client track function with the event, properties and uuid as distinct_id', ->
		@eventTracker.track('Test event 2', { appId: 'someOtherValue' })
		expect(@eventTracker.logEvent).to.be.calledWith('Event:', 'Test event 2', JSON.stringify({ appId: 'someOtherValue' }))
		expect(@eventTracker.client.track).to.be.calledWith('Test event 2', {
			appId: 'someOtherValue'
			uuid: 'barbaz'
			distinct_id: 'barbaz'
			supervisorVersion
		})

	it 'can be passed an Error and it is added to the event properties', ->
		theError = new Error('something went wrong')
		@eventTracker.track('Error event', theError)
		expect(@eventTracker.client.track).to.be.calledWith('Error event', {
			error:
				message: theError.message
				stack: theError.stack
			uuid: 'barbaz'
			distinct_id: 'barbaz'
			supervisorVersion
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
		expect(@eventTracker.client.track).to.be.calledWith('Some app event', {
			service: { appId: '1' }
			uuid: 'barbaz'
			distinct_id: 'barbaz'
			supervisorVersion
		})

	it 'should handle being passed no properties object', ->
		expect(@eventTracker.track('no-options')).to.not.throw

	describe 'Rate limiting', ->

		it 'should rate limit events of the same type', ->
			@eventTracker.client.track.reset()

			@eventTracker.track('test', { });
			@eventTracker.track('test', { });
			@eventTracker.track('test', { });
			@eventTracker.track('test', { });
			@eventTracker.track('test', { });

			expect(@eventTracker.client.track).to.have.callCount(1)

		it 'should rate limit events of the same type with different arguments', ->
			@eventTracker.client.track.reset()

			@eventTracker.track('test2', { a: 1 });
			@eventTracker.track('test2', { b: 2 });
			@eventTracker.track('test2', { c: 3 });
			@eventTracker.track('test2', { d: 4 });
			@eventTracker.track('test2', { e: 5 });

			expect(@eventTracker.client.track).to.have.callCount(1)

		it 'should not rate limit events of different types', ->
			@eventTracker.client.track.reset()

			@eventTracker.track('test3', { a: 1 });
			@eventTracker.track('test4', { b: 2 });
			@eventTracker.track('test5', { c: 3 });
			@eventTracker.track('test6', { d: 4 });
			@eventTracker.track('test7', { e: 5 });

			expect(@eventTracker.client.track).to.have.callCount(5)

