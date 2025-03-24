import { expect } from 'chai';
import type * as sinon from 'sinon';

import { Network } from '~/src/compose/network';
import type { NetworkInspectInfo } from '~/src/compose/types';

import { log } from '~/lib/supervisor-console';

describe('compose/network', () => {
	describe('creating a network from a compose object', () => {
		it('creates a default network configuration if no config is given', () => {
			const network = Network.fromComposeObject(
				'default',
				12345,
				'deadbeef',
				{},
			);

			expect(network.name).to.equal('default');
			expect(network.appId).to.equal(12345);
			expect(network.appUuid).to.equal('deadbeef');

			// Default configuration options
			expect(network.config.driver).to.equal('bridge');
			expect(network.config.ipam).to.deep.equal({
				driver: 'default',
				config: [],
				options: {},
			});
			expect(network.config.enableIPv6).to.equal(false);
			expect(network.config.labels).to.deep.equal({
				'io.balena.app-id': '12345',
			});
			expect(network.config.options).to.deep.equal({});
			expect(network.config.configOnly).to.equal(false);
		});

		it('normalizes legacy labels', () => {
			const network = Network.fromComposeObject('default', 12345, 'deadbeef', {
				labels: {
					'io.resin.features.something': '1234',
				},
			});

			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '1234',
				'io.balena.app-id': '12345',
			});
		});

		it('accepts valid IPAM configurations', () => {
			const network0 = Network.fromComposeObject('default', 12345, 'deadbeef', {
				ipam: { driver: 'dummy', config: [], options: {} },
			});

			// Default configuration options
			expect(network0.config.ipam).to.deep.equal({
				driver: 'dummy',
				config: [],
				options: {},
			});

			const network1 = Network.fromComposeObject('default', 12345, 'deadbeef', {
				ipam: {
					driver: 'default',
					config: [
						{
							subnet: '172.20.0.0/16',
							ip_range: '172.20.10.0/24',
							aux_addresses: { host0: '172.20.10.15', host1: '172.20.10.16' },
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
						ipRange: '172.20.10.0/24',
						gateway: '172.20.0.1',
						auxAddress: { host0: '172.20.10.15', host1: '172.20.10.16' },
					},
				],
				options: {},
			});
		});

		it('warns about IPAM configuration without both gateway and subnet', () => {
			const logStub = log.warn as sinon.SinonStub;

			Network.fromComposeObject('default', 12345, 'deadbeef', {
				ipam: {
					driver: 'default',
					config: [
						{
							subnet: '172.20.0.0/16',
						},
					],
					options: {},
				},
			});

			expect(logStub).to.have.been.calledOnce;
			expect(logStub).to.have.been.calledWithMatch(
				'Network IPAM config entries must have both a subnet and gateway',
			);

			logStub.resetHistory();

			Network.fromComposeObject('default', 12345, 'deadbeef', {
				ipam: {
					driver: 'default',
					config: [
						{
							gateway: '172.20.0.1',
						},
					],
					options: {},
				},
			});

			expect(logStub).to.have.been.calledOnce;
			expect(logStub).to.have.been.calledWithMatch(
				'Network IPAM config entries must have both a subnet and gateway',
			);
		});

		it('parses values from a compose object', () => {
			const network1 = Network.fromComposeObject('default', 12345, 'deadbeef', {
				driver: 'bridge',
				enable_ipv6: true,
				internal: false,
				ipam: {
					driver: 'default',
					options: {
						'com.docker.ipam-option': 'abcd',
					},
					config: [
						{
							subnet: '172.18.0.0/16',
							gateway: '172.18.0.1',
						},
					],
				},
				driver_opts: {
					'com.docker.network-option': 'abcd',
				},
				labels: {
					'com.docker.some-label': 'yes',
				},
				config_only: true,
			});

			const dockerConfig = network1.toDockerConfig();

			expect(dockerConfig.Driver).to.equal('bridge');
			// Check duplicate forced to be true
			expect(dockerConfig.CheckDuplicate).to.equal(true);
			expect(dockerConfig.Internal).to.equal(false);
			expect(dockerConfig.EnableIPv6).to.equal(true);

			expect(dockerConfig.IPAM).to.deep.equal({
				Driver: 'default',
				Options: {
					'com.docker.ipam-option': 'abcd',
				},
				Config: [
					{
						Subnet: '172.18.0.0/16',
						Gateway: '172.18.0.1',
					},
				],
			});
			// If ConfigOnly is true, Subnet & Gateway remain in config
			// but no actual networks are created.
			expect(dockerConfig.ConfigOnly).to.equal(true);
			expect(dockerConfig.Labels).to.deep.equal({
				'io.balena.supervised': 'true',
				'io.balena.app-id': '12345',
				'com.docker.some-label': 'yes',
				// This label should be present as we've defined a custom ipam config
				'io.balena.private.ipam.config': 'true',
			});

			expect(dockerConfig.Options).to.deep.equal({
				'com.docker.network-option': 'abcd',
			});
		});
	});

	describe('creating a network from docker engine state', () => {
		it('rejects networks without the proper name format', () => {
			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: 'abcd',
				} as NetworkInspectInfo),
			).to.throw();

			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: 'abcd_1234',
				} as NetworkInspectInfo),
			).to.throw();

			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: 'abcd_abcd',
				} as NetworkInspectInfo),
			).to.throw();

			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: '1234',
				} as NetworkInspectInfo),
			).to.throw();

			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: 'a173bdb734884b778f5cc3dffd18733e_default',
					Labels: {}, // no app-id
				} as NetworkInspectInfo),
			).to.throw();
		});

		it('creates a network object from a legacy docker network configuration', () => {
			const network = Network.fromDockerNetwork({
				Id: 'deadbeef',
				Name: '1234_default',
				Driver: 'bridge',
				EnableIPv6: true,
				IPAM: {
					Driver: 'default',
					Options: {},
					Config: [
						{
							Subnet: '172.18.0.0/16',
							Gateway: '172.18.0.1',
						},
					],
				} as NetworkInspectInfo['IPAM'],
				Internal: true,
				Containers: {},
				Options: {
					'com.docker.some-option': 'abcd',
				} as NetworkInspectInfo['Options'],
				Labels: {
					'io.balena.supervised': 'true',
					'io.balena.features.something': '123',
				} as NetworkInspectInfo['Labels'],
				ConfigOnly: false,
			} as NetworkInspectInfo);

			expect(network.appId).to.equal(1234);
			expect(network.name).to.equal('default');
			expect(network.config.enableIPv6).to.equal(true);
			expect(network.config.ipam.driver).to.equal('default');
			expect(network.config.ipam.options).to.deep.equal({});
			expect(network.config.ipam.config).to.deep.equal([
				{
					subnet: '172.18.0.0/16',
					gateway: '172.18.0.1',
				},
			]);
			expect(network.config.internal).to.equal(true);
			expect(network.config.options).to.deep.equal({
				'com.docker.some-option': 'abcd',
			});
			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '123',
			});
			expect(network.config.configOnly).to.equal(false);
		});

		it('creates a network object from a docker network configuration', () => {
			const network = Network.fromDockerNetwork({
				Id: 'deadbeef',
				Name: 'a173bdb734884b778f5cc3dffd18733e_default',
				Driver: 'bridge',
				EnableIPv6: true,
				IPAM: {
					Driver: 'default',
					Options: {},
					Config: [
						{
							Subnet: '172.18.0.0/16',
							Gateway: '172.18.0.1',
						},
					],
				} as NetworkInspectInfo['IPAM'],
				Internal: true,
				Containers: {},
				Options: {
					'com.docker.some-option': 'abcd',
				} as NetworkInspectInfo['Options'],
				Labels: {
					'io.balena.supervised': 'true',
					'io.balena.features.something': '123',
					'io.balena.app-id': '1234',
				} as NetworkInspectInfo['Labels'],
				ConfigOnly: false,
			} as NetworkInspectInfo);

			expect(network.appId).to.equal(1234);
			expect(network.appUuid).to.equal('a173bdb734884b778f5cc3dffd18733e');
			expect(network.name).to.equal('default');
			expect(network.config.enableIPv6).to.equal(true);
			expect(network.config.ipam.driver).to.equal('default');
			expect(network.config.ipam.options).to.deep.equal({});
			expect(network.config.ipam.config).to.deep.equal([
				{
					subnet: '172.18.0.0/16',
					gateway: '172.18.0.1',
				},
			]);
			expect(network.config.internal).to.equal(true);
			expect(network.config.options).to.deep.equal({
				'com.docker.some-option': 'abcd',
			});
			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '123',
				'io.balena.app-id': '1234',
			});
			expect(network.config.configOnly).to.equal(false);
		});

		it('normalizes legacy label names and excludes supervised label', () => {
			const network = Network.fromDockerNetwork({
				Id: 'deadbeef',
				Name: '1234_default',
				IPAM: {
					Driver: 'default',
					Options: {},
					Config: [],
				} as NetworkInspectInfo['IPAM'],
				Labels: {
					'io.resin.features.something': '123',
					'io.balena.features.dummy': 'abc',
					'io.balena.supervised': 'true',
					'io.balena.private.ipam.config': 'true',
				} as NetworkInspectInfo['Labels'],
			} as NetworkInspectInfo);

			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '123',
				'io.balena.features.dummy': 'abc',
				'io.balena.private.ipam.config': 'true',
			});
		});
	});

	describe('creating a network compose configuration from a network instance', () => {
		it('creates a docker compose network object from the internal network config', () => {
			const network = Network.fromDockerNetwork({
				Id: 'deadbeef',
				Name: 'a173bdb734884b778f5cc3dffd18733e_default',
				Driver: 'bridge',
				EnableIPv6: true,
				IPAM: {
					Driver: 'default',
					Options: {},
					Config: [
						{
							Subnet: '172.18.0.0/16',
							Gateway: '172.18.0.1',
						},
					],
				} as NetworkInspectInfo['IPAM'],
				Internal: true,
				Containers: {},
				Options: {
					'com.docker.some-option': 'abcd',
				} as NetworkInspectInfo['Options'],
				Labels: {
					'io.balena.features.something': '123',
					'io.balena.app-id': '12345',
				} as NetworkInspectInfo['Labels'],
				ConfigOnly: true,
			} as NetworkInspectInfo);

			expect(network.appId).to.equal(12345);
			expect(network.appUuid).to.equal('a173bdb734884b778f5cc3dffd18733e');

			// Convert to compose object
			const compose = network.toComposeObject();
			expect(compose.driver).to.equal('bridge');
			expect(compose.driver_opts).to.deep.equal({
				'com.docker.some-option': 'abcd',
			});
			expect(compose.enable_ipv6).to.equal(true);
			expect(compose.internal).to.equal(true);
			expect(compose.ipam).to.deep.equal({
				driver: 'default',
				options: {},
				config: [
					{
						subnet: '172.18.0.0/16',
						gateway: '172.18.0.1',
					},
				],
			});
			expect(compose.labels).to.deep.equal({
				'io.balena.features.something': '123',
				'io.balena.app-id': '12345',
			});
			expect(compose.config_only).to.equal(true);
		});
	});

	describe('generateDockerName', () => {
		it('creates a proper network name from the user given name and the app uuid', () => {
			expect(Network.generateDockerName('deadbeef', 'default')).to.equal(
				'deadbeef_default',
			);
			expect(Network.generateDockerName('deadbeef', 'bleh')).to.equal(
				'deadbeef_bleh',
			);
			expect(Network.generateDockerName(1, 'default')).to.equal('1_default');
		});
	});

	describe('comparing network configurations', () => {
		it('distinguishes a network with custom ipam config from a network without', () => {
			const customIpam = Network.fromComposeObject(
				'default',
				12345,
				'deadbeef',
				{
					ipam: {
						driver: 'default',
						config: [
							{
								subnet: '172.20.0.0/16',
								gateway: '172.20.0.1',
							},
						],
						options: {},
					},
				},
			);
			const noCustomIpam = Network.fromComposeObject(
				'default',
				12345,
				'deadbeef',
				{},
			);

			expect(customIpam.isEqualConfig(noCustomIpam)).to.be.false;
		});

		it('compares configurations recursively', () => {
			expect(
				Network.fromComposeObject(
					'default',
					12345,
					'deadbeef',
					{},
				).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadbeef', {}),
				),
			).to.be.true;
			expect(
				Network.fromComposeObject('default', 12345, 'deadbeef', {
					driver: 'default',
				}).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadbeef', {}),
				),
			).to.be.false;
			expect(
				Network.fromComposeObject('default', 12345, 'deadbeef', {
					enable_ipv6: true,
				}).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadbeef', {}),
				),
			).to.be.false;
			expect(
				Network.fromComposeObject('default', 12345, 'deadbeef', {
					enable_ipv6: false,
					internal: false,
				}).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadbeef', {
						internal: true,
					}),
				),
			).to.be.false;

			// Comparison of a network without the app-uuid and a network
			// with uuid has to return false
			expect(
				Network.fromComposeObject(
					'default',
					12345,
					'deadbeef',
					{},
				).isEqualConfig(
					Network.fromDockerNetwork({
						Id: 'deadbeef',
						Name: '12345_default',
						IPAM: {
							Driver: 'default',
							Options: {},
							Config: [],
						} as NetworkInspectInfo['IPAM'],
						Labels: {
							'io.balena.supervised': 'true',
						} as NetworkInspectInfo['Labels'],
					} as NetworkInspectInfo),
				),
			).to.be.false;
		});
	});
});
