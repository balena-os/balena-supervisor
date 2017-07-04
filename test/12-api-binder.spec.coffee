prepare = require './lib/prepare'
Promise = require 'bluebird'
resinAPI = require './lib/mocked-resin-api'

m = require 'mochainon'
_ = require 'lodash'

{ expect } = m.chai
{ stub, spy } = m.sinon

constants = require '../src/constants'

DB = require('../src/db')
Config = require('../src/config')
DeviceState = require('../src/device-state')
APIBinder = require('../src/api-binder')

describe 'APIBinder', ->

	before ->
		spy(resinAPI, 'registerHandler')
		@server = resinAPI.listen(3000)

	after ->
		resinAPI.registerHandler.restore()
		try
			@server.close()

	describe 'on an OS with deviceApiKey support', =>
		before ->
			prepare()
			@db = new DB()
			@config = new Config({ @db, configPath: '/config-apibinder.json' })
			@eventTracker = {
				track: stub().callsFake (ev, props) ->
					console.log(ev, props)
			}
			@deviceState = new DeviceState({ @db, @config, @eventTracker })
			@apiBinder = new APIBinder({ @db, @config, @eventTracker, @deviceState })
			@db.init()
			.then =>
				@config.init()
			.then =>
				@apiBinder.init(false) # Initializes the clients but doesn't trigger provisioning

		it 'provisions a device', ->
			promise = @apiBinder.provisionDevice()
			expect(promise).to.be.fulfilled
			.then =>
				expect(resinAPI.registerHandler).to.be.calledOnce
				resinAPI.registerHandler.reset()
				expect(@eventTracker.track).to.be.calledWith('Device bootstrap success')

		it 'deletes the provisioning key', ->
			expect(@config.get('apiKey')).to.eventually.be.undefined

	describe "on an OS without deviceApiKey support", =>
		before ->
			@oldOSReleasePath = constants.hostOSVersionPath
			constants.hostOSVersionPath = './test/data/etc/os-release-1x'
			prepare()
			@db = new DB()
			@config = new Config({ @db, configPath: '/config-apibinder.json' })
			@eventTracker = {
				track: stub().callsFake (ev, props) ->
					console.log(ev, props)
			}
			@deviceState = new DeviceState({ @db, @config, @eventTracker })
			@apiBinder = new APIBinder({ @db, @config, @eventTracker, @deviceState })
			@db.init()
			.then =>
				@config.init()
			.then =>
				@apiBinder.init(false) # Initializes the clients but doesn't trigger provisioning

		after ->
			constants.hostOSVersionPath = @oldOSReleasePath

		it 'provisions a device', ->
			promise = @apiBinder.provisionDevice()
			expect(promise).to.be.fulfilled
			.then =>
				expect(resinAPI.registerHandler).to.be.calledOnce
				expect(@eventTracker.track).to.be.calledWith('Device bootstrap success')

		it 'overwrites the provisioning key with the device apikey', ->
			@config.getMany([ 'apiKey', 'deviceApiKey' ])
			.then ({ apiKey, deviceApiKey }) ->
				expect(apiKey).to.be.a('string')
				expect(apiKey).to.equal(deviceApiKey)
