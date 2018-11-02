https = require 'https'
stream = require 'stream'
zlib = require 'zlib'

Promise = require 'bluebird'
m = require 'mochainon'
{ expect } = m.chai
{ stub } = m.sinon

{ Logger } = require '../src/logger'
describe 'Logger', ->
	beforeEach ->
		@_req = new stream.PassThrough()
		@_req.flushHeaders = m.sinon.spy()
		@_req.end = m.sinon.spy()

		@_req.body = ''
		@_req
			.pipe(zlib.createGunzip())
			.on 'data', (chunk) =>
				@_req.body += chunk

		stub(https, 'request').returns(@_req)

		@fakeEventTracker = {
			track: m.sinon.spy()
		}

		@logger = new Logger({ eventTracker: @fakeEventTracker })
		@logger.init({
			apiEndpoint: 'https://example.com'
			uuid: 'deadbeef'
			deviceApiKey: 'secretkey'
			offlineMode: false
			enableLogs: true
			localMode: false
		})

	afterEach ->
		https.request.restore()

	it 'waits the grace period before sending any logs', ->
		clock = m.sinon.useFakeTimers()
		@logger.log({ message: 'foobar', serviceId: 15 })
		clock.tick(4999)
		clock.restore()

		Promise.delay(100)
		.then =>
			expect(@_req.body).to.equal('')

	it 'tears down the connection after inactivity', ->
		clock = m.sinon.useFakeTimers()
		@logger.log({ message: 'foobar', serviceId: 15 })
		clock.tick(61000)
		clock.restore()

		Promise.delay(100)
		.then =>
			expect(@_req.end.calledOnce).to.be.true


	it 'sends logs as gzipped ndjson', ->
		clock = m.sinon.useFakeTimers()
		@logger.log({ message: 'foobar', serviceId: 15 })
		@logger.log({ timestamp: 1337, message: 'foobar', serviceId: 15 })
		@logger.log({ message: 'foobar' }) # shold be ignored
		clock.tick(10000)
		clock.restore()

		expect(https.request.calledOnce).to.be.true
		opts = https.request.firstCall.args[0]

		expect(opts.href).to.equal('https://example.com/device/v2/deadbeef/log-stream')
		expect(opts.method).to.equal('POST')
		expect(opts.headers).to.deep.equal({
			'Authorization': 'Bearer secretkey'
			'Content-Type': 'application/x-ndjson'
			'Content-Encoding': 'gzip'
		})

		# small delay for the streams to propagate data
		Promise.delay(100)
		.then =>
			lines = @_req.body.split('\n')
			expect(lines.length).to.equal(3)
			expect(lines[2]).to.equal('')

			msg = JSON.parse(lines[0])
			expect(msg).to.deep.equal({ timestamp: 0, message: 'foobar', serviceId: 15 })
			msg = JSON.parse(lines[1])
			expect(msg).to.deep.equal({ timestamp: 1337, message: 'foobar', serviceId: 15 })

	it 'allows logging system messages which are also reported to the eventTracker', ->
		clock = m.sinon.useFakeTimers()
		@logger.logSystemMessage('Hello there!', { someProp: 'someVal' }, 'Some event name')
		clock.tick(10000)
		clock.restore()

		Promise.delay(100)
		.then =>
			expect(@fakeEventTracker.track).to.be.calledWith('Some event name', { someProp: 'someVal' })
			lines = @_req.body.split('\n')
			expect(lines.length).to.equal(2)
			expect(lines[1]).to.equal('')

			msg = JSON.parse(lines[0])
			expect(msg).to.deep.equal({ message: 'Hello there!', timestamp: 0, isSystem: true })

	it 'should support non-tty log lines', ->
		message = '\u0001\u0000\u0000\u0000\u0000\u0000\u0000?2018-09-21T12:37:09.819134000Z this is the message'
		buffer = Buffer.from(message)

		expect(Logger.extractContainerMessage(buffer)).to.deep.equal({
			message: 'this is the message',
			timestamp: 1537533429819
		})
