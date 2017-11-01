prepare = require './lib/prepare'
Promise = require 'bluebird'
m = require 'mochainon'

{ expect } = m.chai

Service = require '../src/compose/service'
describe 'Service', ->
	before ->
		prepare()

	it 'extends environment variables properly', ->
		extendEnvVarsOpts = {
			uuid: '1234'
			appName: 'awesomeApp'
			commit: 'abcdef'
			name: 'awesomeDevice'
			version: 'v1.0.0'
			deviceType: 'raspberry-pie'
			osVersion: 'Resin OS 2.0.2'
		}
		service = {
			appId: '23'
			releaseId: 2
			serviceId: 3
			imageId: 4
			serviceName: 'serviceName'
			environment:
				FOO: 'bar'
				A_VARIABLE: 'ITS_VALUE'
		}
		s = new Service(service, extendEnvVarsOpts)

		expect(s.environment).to.deep.equal({
			FOO: 'bar'
			A_VARIABLE: 'ITS_VALUE'
			RESIN_APP_ID: '23'
			RESIN_APP_NAME: 'awesomeApp'
			RESIN_APP_COMMIT: 'abcdef'
			RESIN_APP_RELEASE: '2'
			RESIN_DEVICE_UUID: '1234'
			RESIN_DEVICE_NAME_AT_INIT: 'awesomeDevice'
			RESIN_DEVICE_TYPE: 'raspberry-pie'
			RESIN_HOST_OS_VERSION: 'Resin OS 2.0.2'
			RESIN_SERVICE_NAME: 'serviceName'
			RESIN_SUPERVISOR_VERSION: 'v1.0.0'
			RESIN_APP_LOCK_PATH: '/tmp/resin/resin-updates.lock'
			RESIN_SERVICE_KILL_ME_PATH: '/tmp/resin/resin-kill-me'
			RESIN: '1'
			USER: 'root'
		})

	it 'returns the correct default bind mounts', ->
		s = new Service({
			appId: '1234'
			serviceName: 'foo'
			releaseId: 2
			serviceId: 3
			imageId: 4
		})
		binds = s.defaultBinds()
		expect(binds).to.deep.equal([
			'/tmp/resin-supervisor/services/1234/foo:/tmp/resin'
		])
