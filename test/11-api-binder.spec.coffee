prepare = require './lib/prepare'
Promise = require 'bluebird'
resinAPI = require './lib/mocked-resin-api'
fs = Promise.promisifyAll(require('fs'))

m = require 'mochainon'
{ expect } = m.chai
{ stub, spy } = m.sinon

DB = require('../src/db')
Config = require('../src/config')
DeviceState = require('../src/device-state')
APIBinder = require('../src/api-binder')

initModels = (filename) ->
	@timeout(5000)
	prepare()
	@db = new DB()
	@config = new Config({ @db, configPath: filename })
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
		@apiBinder.initClient() # Initializes the clients but doesn't trigger provisioning

mockProvisioningOpts = {
	apiEndpoint: 'http://0.0.0.0:3000'
	uuid: 'abcd'
	deviceApiKey: 'averyvalidkey'
	provisioningApiKey: 'anotherveryvalidkey'
	apiTimeout: 30000
}

describe 'APIBinder', ->
	before ->
		spy(resinAPI.resinBackend, 'registerHandler')
		@server = resinAPI.listen(3000)
	after ->
		resinAPI.resinBackend.registerHandler.restore()
		try
			@server.close()

	# We do not support older OS versions anymore, so we only test this case
	describe 'on an OS with deviceApiKey support', ->
		before ->
			initModels.call(this, '/config-apibinder.json')

		it 'provisions a device', ->
			promise = @apiBinder.provisionDevice()
			expect(promise).to.be.fulfilled
			.then =>
				expect(resinAPI.resinBackend.registerHandler).to.be.calledOnce
				resinAPI.resinBackend.registerHandler.reset()
				expect(@eventTracker.track).to.be.calledWith('Device bootstrap success')

		it 'deletes the provisioning key', ->
			expect(@config.get('apiKey')).to.eventually.be.undefined

		it 'sends the correct parameters when provisioning', ->
			fs.readFileAsync('./test/data/config-apibinder.json')
			.then(JSON.parse)
			.then (conf) ->
				expect(resinAPI.resinBackend.devices).to.deep.equal({
					'1': {
						id: 1
						user: conf.userId
						application: conf.applicationId
						uuid: conf.uuid
						device_type: conf.deviceType
						api_key: conf.deviceApiKey
					}
				})

	describe 'fetchDevice', ->
		before ->
			initModels.call(this, '/config-apibinder.json')

		it 'gets a device by its uuid from the Resin API', ->
			# Manually add a device to the mocked API
			resinAPI.resinBackend.devices[3] = {
				id: 3
				user: 'foo'
				application: 1337
				uuid: 'abcd'
				device_type: 'intel-nuc'
				api_key: 'verysecure'
			}
			@apiBinder.fetchDevice('abcd', 'someApiKey', 30000)
			.then (theDevice) ->
				expect(theDevice).to.deep.equal(resinAPI.resinBackend.devices[3])

	describe '_exchangeKeyAndGetDevice', ->
		before ->
			initModels.call(this, '/config-apibinder.json')

		it 'returns the device if it can fetch it with the deviceApiKey', ->
			spy(resinAPI.resinBackend, 'deviceKeyHandler')
			fetchDeviceStub = stub(@apiBinder, 'fetchDevice')
			fetchDeviceStub.onCall(0).resolves({ id: 1 })
			@apiBinder._exchangeKeyAndGetDevice(mockProvisioningOpts)
			.then (device) =>
				expect(resinAPI.resinBackend.deviceKeyHandler).to.not.be.called
				expect(device).to.deep.equal({ id: 1 })
				expect(@apiBinder.fetchDevice).to.be.calledOnce
				@apiBinder.fetchDevice.restore()
				resinAPI.resinBackend.deviceKeyHandler.restore()

		it 'throws if it cannot get the device with any of the keys', ->
			spy(resinAPI.resinBackend, 'deviceKeyHandler')
			stub(@apiBinder, 'fetchDevice').returns(Promise.resolve(null))
			promise = @apiBinder._exchangeKeyAndGetDevice(mockProvisioningOpts)
			promise.catch(->)
			expect(promise).to.be.rejected
			.then =>
				expect(resinAPI.resinBackend.deviceKeyHandler).to.not.be.called
				expect(@apiBinder.fetchDevice).to.be.calledTwice
				@apiBinder.fetchDevice.restore()
				resinAPI.resinBackend.deviceKeyHandler.restore()

		it 'exchanges the key and returns the device if the provisioning key is valid', ->
			spy(resinAPI.resinBackend, 'deviceKeyHandler')
			fetchDeviceStub = stub(@apiBinder, 'fetchDevice')
			fetchDeviceStub.onCall(0).returns(Promise.resolve(null))
			fetchDeviceStub.onCall(1).returns(Promise.resolve({ id: 1 }))
			@apiBinder._exchangeKeyAndGetDevice(mockProvisioningOpts)
			.then (device) =>
				expect(resinAPI.resinBackend.deviceKeyHandler).to.be.calledOnce
				expect(device).to.deep.equal({ id: 1 })
				expect(@apiBinder.fetchDevice).to.be.calledTwice
				@apiBinder.fetchDevice.restore()
				resinAPI.resinBackend.deviceKeyHandler.restore()

	describe 'offline mode', ->
		before ->
			initModels.call(this, '/config-apibinder-offline.json')

		it 'does not generate a key if the device is in offline mode', ->
			@config.get('offlineMode').then (mode) =>
				# Ensure offline mode is set
				expect(mode).to.equal(true)
				# Check that there is no deviceApiKey
				@config.getMany([ 'deviceApiKey', 'uuid' ]).then (conf) ->
					expect(conf['deviceApiKey']).to.be.undefined
					expect(conf['uuid']).to.not.be.undefined

		describe 'Minimal config offline mode', ->
			before ->
				initModels.call(this, '/config-apibinder-offline2.json')

			it 'does not generate a key with the minimal config', ->
				@config.get('offlineMode').then (mode) =>
					expect(mode).to.equal(true)
					@config.getMany([ 'deviceApiKey', 'uuid' ]).then (conf) ->
						expect(conf['deviceApiKey']).to.be.undefined
						expect(conf['uuid']).to.not.be.undefined
