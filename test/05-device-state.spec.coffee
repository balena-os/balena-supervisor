Promise = require 'bluebird'
m = require 'mochainon'

{ stub } = m.sinon
m.chai.use(require('chai-events'))
{ expect } = m.chai

prepare = require './lib/prepare'
DeviceState = require '../src/device-state'
DB = require('../src/db')
Config = require('../src/config')

Service = require '../src/compose/service'

testTarget1 = {
	local: {
		name: 'aDevice'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '256'
			'RESIN_HOST_LOG_TO_DISPLAY': '0'
			'RESIN_SUPERVISOR_CONNECTIVITY_CHECK': 'true'
			'RESIN_SUPERVISOR_DELTA': 'false'
			'RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT': ''
			'RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT': ''
			'RESIN_SUPERVISOR_DELTA_RETRY_COUNT': ''
			'RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL': ''
			'RESIN_SUPERVISOR_LOCAL_MODE': 'false'
			'RESIN_SUPERVISOR_LOG_CONTROL': 'true'
			'RESIN_SUPERVISOR_OVERRIDE_LOCK': 'false'
			'RESIN_SUPERVISOR_POLL_INTERVAL': '60000'
			'RESIN_SUPERVISOR_VPN_CONTROL': 'true'
		}
		apps:[
			{
				appId: '1234'
				name: 'superapp'
				commit: 'abcdef'
				releaseId: '1'
				services: [
					{
						appId: '1234'
						serviceId: '23'
						imageId: '12345'
						serviceName: 'someservice'
						releaseId: '1'
						image: 'registry2.resin.io/superapp/abcdef:latest'
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '23'
							'io.resin.image_id': '12345'
							'io.resin.something': 'bar'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'someservice'
							'io.resin.commit': 'abcdef'
						}
						environment: {
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						volumes: [
							'/tmp/resin-supervisor/services/1234/someservice:/tmp/resin'
						]
						running: true
						expose: []
						ports: []
						cap_add: []
						cap_drop: []
						commit: 'abcdef'
						network_mode: '1234'
						devices: []
					}
				]
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

testTarget2 = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: {
			'1234': {
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: {
					'23': {
						serviceName: 'aservice'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc'
						environment: {
							'FOO': 'bar'
						}
						labels: {}
					},
					'24': {
						serviceName: 'anotherService'
						imageId: '12346'
						image: 'registry2.resin.io/superapp/afaff'
						environment: {
							'FOO': 'bro'
						}
						labels: {}
					}
				}
			}
		}
	}
	dependent: { apps: [], devices: [] }
}
testTargetWithDefaults2 = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
			'RESIN_SUPERVISOR_CONNECTIVITY_CHECK': 'true'
			'RESIN_SUPERVISOR_DELTA': 'false'
			'RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT': ''
			'RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT': ''
			'RESIN_SUPERVISOR_DELTA_RETRY_COUNT': ''
			'RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL': ''
			'RESIN_SUPERVISOR_LOCAL_MODE': 'false'
			'RESIN_SUPERVISOR_LOG_CONTROL': 'true'
			'RESIN_SUPERVISOR_OVERRIDE_LOCK': 'false'
			'RESIN_SUPERVISOR_POLL_INTERVAL': '60000'
			'RESIN_SUPERVISOR_VPN_CONTROL': 'true'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: [
					{
						appId: '1234'
						releaseId: '2'
						serviceId: '23'
						serviceName: 'aservice'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'bar'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						volumes: [
							'/tmp/resin-supervisor/services/1234/aservice:/tmp/resin'
						]
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '23'
							'io.resin.image_id': '12345'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'aservice'
							'io.resin.commit': 'afafafa'
						}
						running: true
						expose: []
						ports: []
						cap_add: []
						cap_drop: []
						commit: 'afafafa'
						network_mode: '1234'
						devices: []
					},
					{
						appId: '1234'
						releaseId: '2'
						serviceId: '24'
						serviceName: 'anotherService'
						imageId: '12346'
						image: 'registry2.resin.io/superapp/afaff:latest'
						environment: {
							'FOO': 'bro'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						volumes: [
							'/tmp/resin-supervisor/services/1234/anotherService:/tmp/resin'
						]
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '24'
							'io.resin.image_id': '12346'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'anotherService'
							'io.resin.commit': 'afafafa'
						}
						running: true
						expose: []
						ports: []
						cap_add: []
						cap_drop: []
						commit: 'afafafa'
						network_mode: '1234'
						devices: []
					}
				]
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

testTargetInvalid = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				config: {}
				services: [
					{
						serviceId: '23'
						serviceName: 'aservice'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc'
						config: {}
						environment: {
							' FOO': 'bar'
						}
						labels: {}
					},
					{
						serviceId: '24'
						serviceName: 'anotherService'
						imageId: '12346'
						image: 'registry2.resin.io/superapp/afaff'
						config: {}
						environment: {
							'FOO': 'bro'
						}
						labels: {}
					}
				]
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

describe 'deviceState', ->
	before ->
		@timeout(5000)
		prepare()
		@db = new DB()
		@config = new Config({ @db })
		eventTracker = {
			track: console.log
		}
		stub(Service.prototype, 'extendEnvVars').callsFake (env) ->
			@environment['ADDITIONAL_ENV_VAR'] = 'foo'
			return @environment
		@deviceState = new DeviceState({ @db, @config, eventTracker })
		stub(@deviceState.applications.docker, 'defaultBridgeGateway').returns(Promise.resolve('172.17.0.1'))
		stub(@deviceState.applications.docker, 'getNetworkGateway').returns(Promise.resolve('172.17.0.1'))
		@db.init()
		.then =>
			@config.init()

	after ->
		Service.prototype.extendEnvVars.restore()
		@deviceState.applications.docker.defaultBridgeGateway.restore()
		@deviceState.applications.docker.getNetworkGateway.restore()

	it 'loads a target state from an apps.json file and saves it as target state, then returns it', ->
		@deviceState.loadTargetFromFile(process.env.ROOT_MOUNTPOINT + '/apps.json')
		.then =>
			@deviceState.getTarget()
		.then (targetState) ->
			# We serialize and parse JSON to avoid checking fields that are functions or undefined
			expect(JSON.parse(JSON.stringify(targetState))).to.deep.equal(testTarget1)

	it 'emits a change event when a new state is reported', ->
		@deviceState.reportCurrentState({ someStateDiff: 'someValue' })
		expect(@deviceState).to.emit('change')

	it 'returns the current state'

	it 'writes the target state to the db with some extra defaults', ->
		@deviceState.setTarget(testTarget2)
		.then =>
			@deviceState.getTarget()
		.then (target) ->
			expect(JSON.parse(JSON.stringify(target))).to.deep.equal(testTargetWithDefaults2)

	it 'does not allow setting an invalid target state', ->
		promise = @deviceState.setTarget(testTargetInvalid)
		promise.catch(->)
		expect(promise).to.be.rejected

	it 'allows triggering applying the target state', (done) ->
		stub(@deviceState, 'applyTarget')
		@deviceState.triggerApplyTarget({ force: true })
		expect(@deviceState.applyTarget).to.not.be.called
		setTimeout =>
			expect(@deviceState.applyTarget).to.be.calledWith({ force: true })
			@deviceState.applyTarget.restore()
			done()
		, 5

	it 'applies the target state for device config'

	it 'applies the target state for applications'
