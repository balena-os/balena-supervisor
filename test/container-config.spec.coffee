require './lib/prepare'
Promise = require 'bluebird'
m = require 'mochainon'

{ expect } = m.chai

containerConfig = require '../src/lib/container-config'
describe 'container-config.coffee', ->

	it 'extends environment variables properly', ->
		extendEnvVarsOpts = {
			uuid: '1234'
			appId: 23
			appName: 'awesomeApp'
			commit: 'abcd'
			listenPort: 8080
			name: 'awesomeDevice'
			apiSecret: 'donttellanyone'
			deviceApiKey: 'reallydonttellanyone'
			version: 'v1.0.0'
			deviceType: 'raspberry-pie'
			osVersion: 'Resin OS 2.0.2'
		}
		env = {
			FOO: 'bar'
			A_VARIABLE: 'ITS_VALUE'
		}
		promise = containerConfig.extendEnvVars(env, extendEnvVarsOpts)

		expect(promise).to.eventually.deep.equal({
			FOO: 'bar'
			A_VARIABLE: 'ITS_VALUE'
			RESIN_APP_ID: '23'
			RESIN_APP_NAME: 'awesomeApp'
			RESIN_APP_RELEASE: 'abcd'
			RESIN_DEVICE_UUID: '1234'
			RESIN_DEVICE_NAME_AT_INIT: 'awesomeDevice'
			RESIN_DEVICE_TYPE: 'raspberry-pie'
			RESIN_HOST_OS_VERSION: 'Resin OS 2.0.2'
			RESIN_SUPERVISOR_ADDRESS: "http://127.0.0.1:8080"
			RESIN_SUPERVISOR_HOST: '127.0.0.1'
			RESIN_SUPERVISOR_PORT: '8080'
			RESIN_SUPERVISOR_API_KEY: 'donttellanyone'
			RESIN_SUPERVISOR_VERSION: 'v1.0.0'
			RESIN_API_KEY: 'reallydonttellanyone'
			RESIN: '1'
			USER: 'root'
		})

	it 'returns the correct default volumes', ->
		volumes = containerConfig.defaultVolumes()
		expect(volumes).to.deep.equal({
			'/data': {}
			'/lib/modules': {}
			'/lib/firmware': {}
			'/host/run/dbus': {}
		})

	it 'returns the correct default volumes with Resin OS V1 volumes enabled', ->
		volumes = containerConfig.defaultVolumes(true)
		expect(volumes).to.deep.equal({
			'/data': {}
			'/lib/modules': {}
			'/lib/firmware': {}
			'/host/run/dbus': {}
			'/host/var/lib/connman': {}
			'/host_run/dbus': {}
		})

	it 'returns the correct default bind mounts', ->
		binds = containerConfig.defaultBinds('1234')
		expect(binds).to.deep.equal([
			'/resin-data/1234:/data'
			'/tmp/resin-supervisor/1234:/tmp/resin'
			'/lib/modules:/lib/modules'
			'/lib/firmware:/lib/firmware'
			'/run/dbus:/host/run/dbus'
		])

	it 'returns the correct default bind mounts with Resin OS V1 volumes enabled', ->
		binds = containerConfig.defaultBinds('1234', true)
		expect(binds).to.deep.equal([
			'/resin-data/1234:/data'
			'/tmp/resin-supervisor/1234:/tmp/resin'
			'/lib/modules:/lib/modules'
			'/lib/firmware:/lib/firmware'
			'/run/dbus:/host/run/dbus'
			'/run/dbus:/host_run/dbus'
			'/var/lib/connman:/host/var/lib/connman'
		])
