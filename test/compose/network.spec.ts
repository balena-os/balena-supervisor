import { expect } from 'chai';

import { Network } from '../../src/compose/network';

describe('Network', () => {
	describe('fromComposeObject', () => {
		it('creates a default network configuration if no config is given', () => {
			const network = Network.fromComposeObject('default', 12345, {});

			expect(network.name).to.equal('default');
			expect(network.appId).to.equal(12345);

			// Default configuration options
			expect(network.config.driver).to.equal('bridge');
			expect(network.config.ipam).to.deep.equal({
				driver: 'default',
				config: [],
				options: {},
			});
			expect(network.config.enableIPv6).to.equal(false);
			expect(network.config.labels).to.deep.equal({});
			expect(network.config.options).to.deep.equal({});
		});

		it('normalizes legacy labels', () => {
			const network = Network.fromComposeObject('default', 12345, {
				labels: {
					'io.resin.features.something': '1234',
				},
			});

			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '1234',
			});
		});

		it('accepts valid IPAM configurations', () => {
			const network0 = Network.fromComposeObject('default', 12345, {
				ipam: { driver: 'dummy', config: [], options: {} },
			});

			// Default configuration options
			expect(network0.config.ipam).to.deep.equal({
				driver: 'dummy',
				config: [],
				options: {},
			});

			const network1 = Network.fromComposeObject('default', 12345, {
				ipam: {
					driver: 'default',
					config: [
						{
							subnet: '172.20.0.0/16',
							ip_range: '172.20.10.0/24',
							gateway: '172.20.0.1',
						},
					],
					options: {},
				},
			});

			// Default configuration options
			expect(network1.config.ipam).to.deep.equal({
				driver: 'default',
				config: [
					{
						subnet: '172.20.0.0/16',
						ip_range: '172.20.10.0/24',
						gateway: '172.20.0.1',
					},
				],
				options: {},
			});
		});

		it('rejects IPAM configuration without both gateway and subnet', () => {
			expect(() =>
				Network.fromComposeObject('default', 12345, {
					ipam: {
						driver: 'default',
						config: [
							{
								subnet: '172.20.0.0/16',
							},
						],
						options: {},
					},
				}),
			).to.throw(
				'Network IPAM config entries must have both a subnet and gateway',
			);

			expect(() =>
				Network.fromComposeObject('default', 12345, {
					ipam: {
						driver: 'default',
						config: [
							{
								gateway: '172.20.0.1',
							},
						],
						options: {},
					},
				}),
			).to.throw(
				'Network IPAM config entries must have both a subnet and gateway',
			);
		});
	});
});
