Promise = require 'bluebird'
m = require 'mochainon'
fs = Promise.promisifyAll(require('fs'))

# Create a test config.json before requiring the library
fs.writeFileSync('./test/data/config.json', fs.readFileSync('./test/data/testconfig.json'))

{ expect } = m.chai

describe 'config.coffee', ->
	knex = new require('../src/db')()
	config = new require('../src/config')({ db: knex })
	initialization = null

	before ->
		initialization = knex.init().then(config.init)

	it 'uses the correct config.json path', ->
		expect(config.configJsonPath()).to.eventually.equal('./test/data/config.json')

	it 'initializes correctly', ->
		expect(initialization).to.be.fulfilled

	it 'reads and exposes values from the config.json', ->
		promise = config.getMany(['apiEndpoint', 'applicationId'])
		expect(promise).to.eventually.deep.equal([ 'https://api.resin.io', 78373 ])

	it 'provides the correct pubnub config', ->
		promise = config.get('pubnub')
		expect(promise).to.eventually.deep.equal({ subscribe_key: 'foo', publish_key: 'bar', ssl: true })

	it 'generates a uuid and stores it in config.json', ->
		promise = config.get('uuid')
		promise2 = fs.readFileAsync('./test/data/config.json').then(JSON.parse).get('uuid')
		Promise.all([
			expect(promise).to.be.fulfilled
			expect(promise).to.be.fulfilled
		]).then ([uuid1, uuid2]) ->
			expect(uuid1).to.be.a('string')
			expect(uuid1).to.have.lengthOf(62)
			expect(uuid1).to.equal(uuid2)

	it 'does not allow setting an immutable field', ->
		promise = config.set({ username: 'somebody else' })
		# We catch it to avoid the unhandled error log
		promise.catch(->)
		expect(promise).to.throw

	it 'allows setting both config.json and database fields transparently', ->
		promise = config.set({ appUpdatePollInterval: 30000, name: 'a new device name'}).then ->
			config.getMany([ 'appUpdatePollInterval', 'name' ])
		expect(promise).to.eventually.deep.equal([ 30000, 'a new device name' ])
