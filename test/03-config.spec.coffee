prepare = require './lib/prepare'
Promise = require 'bluebird'
m = require 'mochainon'
fs = Promise.promisifyAll(require('fs'))
_ = require 'lodash'
m.chai.use(require('chai-events'))
{ expect } = m.chai

DB = require('../src/db')
Config = require('../src/config')

describe 'Config', ->
	before ->
		prepare()
		@db = new DB()
		@conf = new Config({ @db })
		@initialization = @db.init().then =>
			@conf.init()

	it 'uses the correct config.json path', ->
		expect(@conf.configJsonPath()).to.eventually.equal('./test/data/config.json')

	it 'uses the correct config.json path from the root mount when passed as argument to the constructor', ->
		conf2 = new Config({ @db, configPath: '/foo.json' })
		expect(conf2.configJsonPath()).to.eventually.equal('./test/data/foo.json')

	it 'initializes correctly', ->
		expect(@initialization).to.be.fulfilled

	it 'reads and exposes values from the config.json', ->
		promise = @conf.get('applicationId')
		expect(promise).to.eventually.equal(78373)

	it 'allows reading several values in one getMany call', ->
		promise = @conf.getMany([ 'applicationId', 'apiEndpoint' ])
		expect(promise).to.eventually.deep.equal({ applicationId: 78373, apiEndpoint: 'https://api.resin.io' })

	it 'provides the correct pubnub config', ->
		promise = @conf.get('pubnub')
		expect(promise).to.eventually.deep.equal({ subscribe_key: 'foo', publish_key: 'bar', ssl: true })

	it 'generates a uuid and stores it in config.json', ->
		promise = @conf.get('uuid')
		promise2 = fs.readFileAsync('./test/data/config.json').then(JSON.parse).get('uuid')
		Promise.all([
			expect(promise).to.be.fulfilled
			expect(promise).to.be.fulfilled
		]).then ([uuid1, uuid2]) ->
			expect(uuid1).to.be.a('string')
			expect(uuid1).to.have.lengthOf(62)
			expect(uuid1).to.equal(uuid2)

	it 'does not allow setting an immutable field', ->
		promise = @conf.set({ username: 'somebody else' })
		# We catch it to avoid the unhandled error log
		promise.catch(->)
		expect(promise).to.be.rejected

	it 'allows setting both config.json and database fields transparently', ->
		promise = @conf.set({ appUpdatePollInterval: 30000, name: 'a new device name'}).then =>
			@conf.getMany([ 'appUpdatePollInterval', 'name' ])
		expect(promise).to.eventually.deep.equal({ appUpdatePollInterval: 30000, name: 'a new device name' })

	it 'allows removing a db key', ->
		promise = @conf.remove('name').then =>
			@conf.get('name')
		expect(promise).to.be.fulfilled
		expect(promise).to.eventually.be.undefined

	it 'allows deleting a config.json key and returns a default value if none is set', ->
		promise = @conf.remove('appUpdatePollInterval').then =>
			@conf.get('appUpdatePollInterval')
		expect(promise).to.be.fulfilled
		expect(promise).to.eventually.equal(60000)

	it 'allows deleting a config.json key if it is null', ->
		promise = @conf.set('apiKey': null).then =>
			@conf.get('apiKey')
		expect(promise).to.be.fulfilled
		expect(promise).to.eventually.be.undefined
		.then ->
			fs.readFileAsync('./test/data/config.json')
		.then(JSON.parse)
		.then (confFromFile) =>
			expect(confFromFile).to.not.have.property('apiKey')

	it 'does not allow modifying or removing a function value', ->
		promise1 = @conf.remove('version')
		promise1.catch(->)
		promise2 = @conf.set(version: '2.0')
		promise2.catch(->)
		Promise.all([
			expect(promise1).to.be.rejected
			expect(promise2).to.be.rejected
		])

	it 'throws when asked for an unknown key', ->
		promise = @conf.get('unknownInvalidValue')
		promise.catch(->)
		expect(promise).to.be.rejected

	it 'emits a change event when values are set', (done) ->
		@conf.on 'change', (val) ->
			expect(val).to.deep.equal({ name: 'someValue' })
			done()
		@conf.set({ name: 'someValue' })
		expect(@conf).to.emit('change')
		return

	it "returns an undefined OS variant if it doesn't exist", ->
		oldPath = @conf.constants.hostOSVersionPath
		@conf.constants.hostOSVersionPath = './test/data/etc/os-release-novariant'
		@conf.get('osVariant')
		.then (osVariant) =>
			@conf.constants.hostOSVersionPath = oldPath
			expect(osVariant).to.be.undefined
