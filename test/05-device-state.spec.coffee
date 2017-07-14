Promise = require 'bluebird'
m = require 'mochainon'

{ stub } = m.sinon
m.chai.use(require('chai-events'))
{ expect } = m.chai

prepare = require './lib/prepare'
DeviceState = require '../src/device-state'
DB = require('../src/db')
Config = require('../src/config')

containerConfig = require '../src/lib/container-config'

testTarget1 = {
	local: {
		name: ''
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '256'
			'RESIN_HOST_LOG_TO_DISPLAY': '0'
		}
		apps:{
			'1234': {
				name: 'superapp'
				image: 'registry2.resin.io/superapp/abcdef'
				commit: 'abcdef'
				environment: {
					'FOO': 'bar'
					'ADDITIONAL_ENV_VAR': 'its value'
				}
				config: {
					'RESIN_HOST_CONFIG_gpu_mem': '256'
					'RESIN_HOST_LOG_TO_DISPLAY': '0'
				}
			}
		}
	}
	dependent: { apps: {}, devices: {}}
}

testTarget2 = {
	local: {
		name: ''
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps:{
			'1234': {
				name: 'superapp'
				image: 'registry2.resin.io/superapp/edfabc'
				commit: 'abcdef'
				environment: {
					'FOO': 'bar'
					'ADDITIONAL_ENV_VAR': 'another value'
				}
				config: {
					'RESIN_HOST_CONFIG_gpu_mem': '256'
					'RESIN_HOST_LOG_TO_DISPLAY': '0'
				}
			}
		}
	}
	dependent: { apps: {}, devices: {}}
}

testTargetInvalid = {
	local: {
		name: ''
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps:{
			'1234': {
				name: 'superapp'
				image: 'registry2.resin.io/superapp/edfabc'
				commit: 'abcdef'
				environment: [{
					'FOO': 'bar'
					'ADDITIONAL_ENV_VAR': 'another value'
				}]
				config: {
					'RESIN_HOST_CONFIG_gpu_mem': '256'
					'RESIN_HOST_LOG_TO_DISPLAY': '0'
				}
			}
		}
	}
	dependent: { apps: {}, devices: {}}
}

describe 'deviceState', ->
	before ->
		prepare()
		@db = new DB()
		@config = new Config({ @db })
		eventTracker = {
			track: console.log
		}
		@deviceState = new DeviceState({ @db, @config, eventTracker })
		stub(containerConfig, 'extendEnvVars').callsFake (env) ->
			env['ADDITIONAL_ENV_VAR'] = 'its value'
			Promise.resolve(env)
		@db.init()
		.then =>
			@config.init()

	after ->
		containerConfig.extendEnvVars.restore()

	it 'loads a target state from an apps.json file and saves it as target state, then returns it', ->
		@config.set({ name: '' })
		.then =>
			@deviceState.loadTargetFromFile(process.env.ROOT_MOUNTPOINT + '/apps.json')
		.then =>
			@deviceState.getTarget()
		.then (targetState) ->
			expect(targetState).to.deep.equal(testTarget1)

	it 'emits a change event when a new state is reported', ->
		@deviceState.reportCurrent({ someStateDiff: 'someValue' })
		expect(@deviceState).to.emit('current-state-change')

	it 'returns the current state'

	it 'writes the target state to the db', ->
		@deviceState.setTarget(testTarget2)
		.then =>
			@deviceState.getTarget()
		.then (target) ->
			expect(target).to.deep.equal(testTarget2)

	it 'does not allow setting an invalid target state', ->
		promise = @deviceState.setTarget(testTargetInvalid)
		promise.catch(->)
		expect(promise).to.be.rejected

	it 'allows triggering applying the target state', (done) ->
		stub(@deviceState, 'applyTarget')
		@deviceState.triggerApplyTarget({ force: true })
		expect(@deviceState.applyTarget).to.not.be.called
		setImmediate =>
			expect(@deviceState.applyTarget).to.be.calledWith({ force: true })
			@deviceState.applyTarget.restore()
			done()

	it 'applies the target state for device config'

	it 'applies the target state for applications'

	it 'calls the proxyvisor to apply dependent device target states'
