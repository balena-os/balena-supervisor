m = require 'mochainon'
{ expect } = m.chai

{ Network } = require '../src/compose/network'

describe 'compose/network', ->

	describe 'compose config -> internal config', ->

		it 'should convert a compose configuration to an internal representation', ->

			network = Network.fromComposeObject({ logger: null, docker: null }, 'test', 123, {
				'driver': 'bridge',
				'ipam': {
					'driver': 'default',
					'config': [
						{
							'subnet': '172.25.0.0/25',
							'gateway': '172.25.0.1'
						}
					]
				}
			})

			expect(network.config).to.deep.equal({
				driver: 'bridge'
				ipam: {
					driver: 'default'
					config: [
						subnet: '172.25.0.0/25'
						gateway: '172.25.0.1'
					]
					options: {}
				}
				enableIPv6: false,
				internal: false,
				labels: {}
				options: {}
			})

	describe 'internal config -> docker config', ->

		it 'should convert an internal representation to a docker representation', ->

			network = Network.fromComposeObject({ logger: null, docker: null }, 'test', 123, {
				'driver': 'bridge',
				'ipam': {
					'driver': 'default',
					'config': [
						{
							'subnet': '172.25.0.0/25',
							'gateway': '172.25.0.1'
						}
					]
				}
			})

			expect(network.toDockerConfig()).to.deep.equal({
				Name: '123_test',
				Driver: 'bridge',
				CheckDuplicate: true,
				IPAM: {
					Driver: 'default',
					Config: [{
						Subnet: '172.25.0.0/25'
						Gateway: '172.25.0.1'
					}]
					Options: {}
				}
				EnableIPv6: false,
				Internal: false,
				Labels: {
					'io.balena.supervised': 'true'
				}
			})
