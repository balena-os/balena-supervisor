m = require 'mochainon'
{ expect } = m.chai
Service = require '../src/compose/service'

describe 'compose/service.cofee', ->

	it 'extends environment variables properly', ->
		extendEnvVarsOpts = {
			uuid: '1234'
			appName: 'awesomeApp'
			commit: 'abcdef'
			name: 'awesomeDevice'
			version: 'v1.0.0'
			deviceType: 'raspberry-pi'
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
			RESIN_DEVICE_UUID: '1234'
			RESIN_DEVICE_NAME_AT_INIT: 'awesomeDevice'
			RESIN_DEVICE_TYPE: 'raspberry-pi'
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

	it 'produces the correct port bindings and exposed ports', ->
		s = new Service({
			appId: '1234'
			serviceName: 'foo'
			releaseId: 2
			serviceId: 3
			imageId: 4
			expose: [
				1000,
				'243/udp'
			],
			ports: [
				'2344'
				'2345:2354'
				'2346:2367/udp'
			]
		}, {
			imageInfo: Config: {
				ExposedPorts: {
					'53/tcp': {}
					'53/udp': {}
					'2354/tcp': {}
				}
			}
		})
		ports = s.generatePortBindings()
		expect(ports.portBindings).to.deep.equal({
			'2344/tcp': [{
				HostIp: '',
				HostPort: '2344'
			}],
			'2354/tcp': [{
				HostIp: '',
				HostPort: '2345'
			}],
			'2367/udp': [{
				HostIp: '',
				HostPort: '2346'
			}]
		})
		expect(ports.exposedPorts).to.deep.equal({
			'1000/tcp': {}
			'243/udp': {}
			'2344/tcp': {}
			'2354/tcp': {}
			'2367/udp': {}
			'53/tcp': {}
			'53/udp': {}
		})

	it 'correctly handles port ranges', ->
		s = new Service({
			appId: '1234'
			serviceName: 'foo'
			releaseId: 2
			serviceId: 3
			imageId: 4
			expose: [
				1000,
				'243/udp'
			],
			ports: [
				'1000-1003:2000-2003'
			]
		})

		ports = s.generatePortBindings()
		expect(ports.portBindings).to.deep.equal({
			'2000/tcp': [
				HostIp: ''
				HostPort: '1000'
			],
			'2001/tcp': [
				HostIp: ''
				HostPort: '1001'
			],
			'2002/tcp': [
				HostIp: ''
				HostPort: '1002'
			],
			'2003/tcp': [
				HostIp: ''
				HostPort: '1003'
			]
		})

		expect(ports.exposedPorts).to.deep.equal({
			'1000/tcp': {}
			'2000/tcp': {}
			'2001/tcp': {}
			'2002/tcp': {}
			'2003/tcp': {}
			'243/udp': {}
		})

	it 'should correctly handle large port ranges', ->
		@timeout(60000)
		s = new Service({
			appId: '1234'
			serviceName: 'foo'
			releaseId: 2
			serviceId: 3
			imageId: 4
			ports: [
				'5-65536:5-65536/tcp'
				'5-65536:5-65536/udp'
			]
		})

		expect(s.generatePortBindings()).to.not.throw


	describe 'parseMemoryNumber()', ->
		makeComposeServiceWithLimit = (memLimit) ->
			new Service(
				appId: 123456
				serviceId: 123456
				serviceName: 'foobar'
				memLimit: memLimit
			)

		it 'should correctly parse memory number strings without a unit', ->
			expect(makeComposeServiceWithLimit('64').memLimit).to.equal(64)

		it 'should correctly apply the default value', ->
			expect(makeComposeServiceWithLimit(undefined).memLimit).to.equal(0)

		it 'should correctly support parsing numbers as memory limits', ->
			expect(makeComposeServiceWithLimit(64).memLimit).to.equal(64)

		it 'should correctly parse memory number strings that use a byte unit', ->
			expect(makeComposeServiceWithLimit('64b').memLimit).to.equal(64)
			expect(makeComposeServiceWithLimit('64B').memLimit).to.equal(64)

		it 'should correctly parse memory number strings that use a kilobyte unit', ->
			expect(makeComposeServiceWithLimit('64k').memLimit).to.equal(65536)
			expect(makeComposeServiceWithLimit('64K').memLimit).to.equal(65536)

			expect(makeComposeServiceWithLimit('64kb').memLimit).to.equal(65536)
			expect(makeComposeServiceWithLimit('64Kb').memLimit).to.equal(65536)

		it 'should correctly parse memory number strings that use a megabyte unit', ->
			expect(makeComposeServiceWithLimit('64m').memLimit).to.equal(67108864)
			expect(makeComposeServiceWithLimit('64M').memLimit).to.equal(67108864)

			expect(makeComposeServiceWithLimit('64mb').memLimit).to.equal(67108864)
			expect(makeComposeServiceWithLimit('64Mb').memLimit).to.equal(67108864)

		it 'should correctly parse memory number strings that use a gigabyte unit', ->
			expect(makeComposeServiceWithLimit('64g').memLimit).to.equal(68719476736)
			expect(makeComposeServiceWithLimit('64G').memLimit).to.equal(68719476736)

			expect(makeComposeServiceWithLimit('64gb').memLimit).to.equal(68719476736)
			expect(makeComposeServiceWithLimit('64Gb').memLimit).to.equal(68719476736)

	describe 'getWorkingDir', ->
		makeComposeServiceWithWorkdir = (workdir) ->
			new Service(
				appId: 123456,
				serviceId: 123456,
				serviceName: 'foobar'
				workingDir: workdir
			)

		it 'should remove a trailing slash', ->
			expect(makeComposeServiceWithWorkdir('/usr/src/app/').workingDir).to.equal('/usr/src/app')
			expect(makeComposeServiceWithWorkdir('/').workingDir).to.equal('/')
			expect(makeComposeServiceWithWorkdir('/usr/src/app').workingDir).to.equal('/usr/src/app')
			expect(makeComposeServiceWithWorkdir('').workingDir).to.equal('')
