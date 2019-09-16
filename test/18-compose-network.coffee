{ expect } = require './lib/chai-config'

{ Network } = require '../src/compose/network'

describe 'compose/network', ->

	describe 'compose config -> internal config', ->

		it 'should convert a compose configuration to an internal representation', ->

			network = Network.fromComposeObject('test', 123, {
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
			}, { logger: null, docker: null })

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

		it 'should handle an incomplete ipam configuration', ->
			network = Network.fromComposeObject('test', 123, {
				ipam: {
					config: [
						{
							subnet: '172.25.0.0/25',
							gateway: '172.25.0.1'
						}
					]
				}
			}, { logger: null, docker: null })

			expect(network.config).to.deep.equal({
				driver: 'bridge',
				enableIPv6: false,
				internal: false,
				labels: {}
				options: {}
				ipam: {
					driver: 'default',
					options: {},
					config: [
						{
							subnet: '172.25.0.0/25',
							gateway: '172.25.0.1'
						}
					]
				}
			})

	describe 'internal config -> docker config', ->

		it 'should convert an internal representation to a docker representation', ->

			network = Network.fromComposeObject('test', 123, {
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
			}, { logger: null, docker: null })

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
