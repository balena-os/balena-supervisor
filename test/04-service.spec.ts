import * as _ from 'lodash';

import ChaiConfig = require('./lib/chai-config');
const { assert, expect } = ChaiConfig;

import Service from '../src/compose/service';
import {
	ServiceComposeConfig,
	ServiceConfig,
} from '../src/compose/types/service';

const configs = {
	simple: {
		compose: require('./data/docker-states/simple/compose.json'),
		imageInfo: require('./data/docker-states/simple/imageInfo.json'),
		inspect: require('./data/docker-states/simple/inspect.json'),
	},
	entrypoint: {
		compose: require('./data/docker-states/entrypoint/compose.json'),
		imageInfo: require('./data/docker-states/entrypoint/imageInfo.json'),
		inspect: require('./data/docker-states/entrypoint/inspect.json'),
	},
	networkModeService: {
		compose: require('./data/docker-states/network-mode-service/compose.json'),
		imageInfo: require('./data/docker-states/network-mode-service/imageInfo.json'),
		inspect: require('./data/docker-states/network-mode-service/inspect.json'),
	},
};

describe('compose/service', () => {
	it('extends environment variables properly', () => {
		const extendEnvVarsOpts = {
			uuid: '1234',
			appName: 'awesomeApp',
			commit: 'abcdef',
			name: 'awesomeDevice',
			version: 'v1.0.0',
			deviceArch: 'amd64',
			deviceType: 'raspberry-pi',
			osVersion: 'Resin OS 2.0.2',
		};
		const service = {
			appId: '23',
			releaseId: 2,
			serviceId: 3,
			imageId: 4,
			serviceName: 'serviceName',
			environment: {
				FOO: 'bar',
				A_VARIABLE: 'ITS_VALUE',
			},
		};
		const s = Service.fromComposeObject(service, extendEnvVarsOpts as any);

		expect(s.config.environment).to.deep.equal({
			FOO: 'bar',
			A_VARIABLE: 'ITS_VALUE',
			RESIN_APP_ID: '23',
			RESIN_APP_NAME: 'awesomeApp',
			RESIN_DEVICE_UUID: '1234',
			RESIN_DEVICE_ARCH: 'amd64',
			RESIN_DEVICE_TYPE: 'raspberry-pi',
			RESIN_HOST_OS_VERSION: 'Resin OS 2.0.2',
			RESIN_SERVICE_NAME: 'serviceName',
			RESIN_SUPERVISOR_VERSION: 'v1.0.0',
			RESIN_APP_LOCK_PATH: '/tmp/balena/updates.lock',
			RESIN_SERVICE_KILL_ME_PATH: '/tmp/balena/handover-complete',
			RESIN: '1',
			BALENA_APP_ID: '23',
			BALENA_APP_NAME: 'awesomeApp',
			BALENA_DEVICE_UUID: '1234',
			BALENA_DEVICE_ARCH: 'amd64',
			BALENA_DEVICE_TYPE: 'raspberry-pi',
			BALENA_HOST_OS_VERSION: 'Resin OS 2.0.2',
			BALENA_SERVICE_NAME: 'serviceName',
			BALENA_SUPERVISOR_VERSION: 'v1.0.0',
			BALENA_APP_LOCK_PATH: '/tmp/balena/updates.lock',
			BALENA_SERVICE_HANDOVER_COMPLETE_PATH: '/tmp/balena/handover-complete',
			BALENA: '1',
			USER: 'root',
		});
	});

	it('returns the correct default bind mounts', () => {
		const s = Service.fromComposeObject(
			{
				appId: '1234',
				serviceName: 'foo',
				releaseId: 2,
				serviceId: 3,
				imageId: 4,
			},
			{ appName: 'foo' } as any,
		);
		const binds = (Service as any).defaultBinds(s.appId, s.serviceName);
		expect(binds).to.deep.equal([
			'/tmp/balena-supervisor/services/1234/foo:/tmp/resin',
			'/tmp/balena-supervisor/services/1234/foo:/tmp/balena',
		]);
	});

	it('produces the correct port bindings and exposed ports', () => {
		const s = Service.fromComposeObject(
			{
				appId: '1234',
				serviceName: 'foo',
				releaseId: 2,
				serviceId: 3,
				imageId: 4,
				expose: [1000, '243/udp'],
				ports: ['2344', '2345:2354', '2346:2367/udp'],
			},
			{
				imageInfo: {
					Config: {
						ExposedPorts: {
							'53/tcp': {},
							'53/udp': {},
							'2354/tcp': {},
						},
					},
				},
			} as any,
		);

		const ports = (s as any).generateExposeAndPorts();
		expect(ports.portBindings).to.deep.equal({
			'2344/tcp': [
				{
					HostIp: '',
					HostPort: '2344',
				},
			],
			'2354/tcp': [
				{
					HostIp: '',
					HostPort: '2345',
				},
			],
			'2367/udp': [
				{
					HostIp: '',
					HostPort: '2346',
				},
			],
		});
		expect(ports.exposedPorts).to.deep.equal({
			'1000/tcp': {},
			'243/udp': {},
			'2344/tcp': {},
			'2354/tcp': {},
			'2367/udp': {},
			'53/tcp': {},
			'53/udp': {},
		});
	});

	it('correctly handles port ranges', () => {
		const s = Service.fromComposeObject(
			{
				appId: '1234',
				serviceName: 'foo',
				releaseId: 2,
				serviceId: 3,
				imageId: 4,
				expose: [1000, '243/udp'],
				ports: ['1000-1003:2000-2003'],
			},
			{ appName: 'test' } as any,
		);

		const ports = (s as any).generateExposeAndPorts();
		expect(ports.portBindings).to.deep.equal({
			'2000/tcp': [
				{
					HostIp: '',
					HostPort: '1000',
				},
			],
			'2001/tcp': [
				{
					HostIp: '',
					HostPort: '1001',
				},
			],
			'2002/tcp': [
				{
					HostIp: '',
					HostPort: '1002',
				},
			],
			'2003/tcp': [
				{
					HostIp: '',
					HostPort: '1003',
				},
			],
		});

		expect(ports.exposedPorts).to.deep.equal({
			'1000/tcp': {},
			'2000/tcp': {},
			'2001/tcp': {},
			'2002/tcp': {},
			'2003/tcp': {},
			'243/udp': {},
		});
	});

	it('should correctly handle large port ranges', function() {
		this.timeout(60000);
		const s = Service.fromComposeObject(
			{
				appId: '1234',
				serviceName: 'foo',
				releaseId: 2,
				serviceId: 3,
				imageId: 4,
				ports: ['5-65536:5-65536/tcp', '5-65536:5-65536/udp'],
			},
			{ appName: 'test' } as any,
		);

		expect((s as any).generateExposeAndPorts()).to.not.throw;
	});

	it('should correctly report implied exposed ports from portMappings', () => {
		const service = Service.fromComposeObject(
			{
				appId: 123456,
				serviceId: 123456,
				serviceName: 'test',
				ports: ['80:80', '100:100'],
			},
			{ appName: 'test' } as any,
		);

		expect(service.config)
			.to.have.property('expose')
			.that.deep.equals(['80/tcp', '100/tcp']);
	});

	describe('Ordered array parameters', () => {
		it('Should correctly compare ordered array parameters', () => {
			const svc1 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					dns: ['8.8.8.8', '1.1.1.1'],
				},
				{ appName: 'test' } as any,
			);
			let svc2 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					dns: ['8.8.8.8', '1.1.1.1'],
				},
				{ appName: 'test' } as any,
			);
			assert(svc1.isEqualConfig(svc2, {}));

			svc2 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					dns: ['1.1.1.1', '8.8.8.8'],
				},
				{ appName: 'test' } as any,
			);
			assert(!svc1.isEqualConfig(svc2, {}));
		});

		it('should correctly compare non-ordered array parameters', () => {
			const svc1 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					volumes: ['abcdef', 'ghijk'],
				},
				{ appName: 'test' } as any,
			);
			let svc2 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					volumes: ['abcdef', 'ghijk'],
				},
				{ appName: 'test' } as any,
			);
			assert(svc1.isEqualConfig(svc2, {}));

			svc2 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					volumes: ['ghijk', 'abcdef'],
				},
				{ appName: 'test' } as any,
			);
			assert(svc1.isEqualConfig(svc2, {}));
		});

		it('should correctly compare both ordered and non-ordered array parameters', () => {
			const svc1 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					volumes: ['abcdef', 'ghijk'],
					dns: ['8.8.8.8', '1.1.1.1'],
				},
				{ appName: 'test' } as any,
			);
			const svc2 = Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					volumes: ['ghijk', 'abcdef'],
					dns: ['8.8.8.8', '1.1.1.1'],
				},
				{ appName: 'test' } as any,
			);
			assert(svc1.isEqualConfig(svc2, {}));
		});
	});

	describe('parseMemoryNumber()', () => {
		const makeComposeServiceWithLimit = (memLimit?: string | number) =>
			Service.fromComposeObject(
				{
					appId: 123456,
					serviceId: 123456,
					serviceName: 'foobar',
					mem_limit: memLimit,
				},
				{ appName: 'test' } as any,
			);

		it('should correctly parse memory number strings without a unit', () =>
			expect(makeComposeServiceWithLimit('64').config.memLimit).to.equal(64));

		it('should correctly apply the default value', () =>
			expect(makeComposeServiceWithLimit(undefined).config.memLimit).to.equal(
				0,
			));

		it('should correctly support parsing numbers as memory limits', () =>
			expect(makeComposeServiceWithLimit(64).config.memLimit).to.equal(64));

		it('should correctly parse memory number strings that use a byte unit', () => {
			expect(makeComposeServiceWithLimit('64b').config.memLimit).to.equal(64);
			expect(makeComposeServiceWithLimit('64B').config.memLimit).to.equal(64);
		});

		it('should correctly parse memory number strings that use a kilobyte unit', () => {
			expect(makeComposeServiceWithLimit('64k').config.memLimit).to.equal(
				65536,
			);
			expect(makeComposeServiceWithLimit('64K').config.memLimit).to.equal(
				65536,
			);

			expect(makeComposeServiceWithLimit('64kb').config.memLimit).to.equal(
				65536,
			);
			expect(makeComposeServiceWithLimit('64Kb').config.memLimit).to.equal(
				65536,
			);
		});

		it('should correctly parse memory number strings that use a megabyte unit', () => {
			expect(makeComposeServiceWithLimit('64m').config.memLimit).to.equal(
				67108864,
			);
			expect(makeComposeServiceWithLimit('64M').config.memLimit).to.equal(
				67108864,
			);

			expect(makeComposeServiceWithLimit('64mb').config.memLimit).to.equal(
				67108864,
			);
			expect(makeComposeServiceWithLimit('64Mb').config.memLimit).to.equal(
				67108864,
			);
		});

		it('should correctly parse memory number strings that use a gigabyte unit', () => {
			expect(makeComposeServiceWithLimit('64g').config.memLimit).to.equal(
				68719476736,
			);
			expect(makeComposeServiceWithLimit('64G').config.memLimit).to.equal(
				68719476736,
			);

			expect(makeComposeServiceWithLimit('64gb').config.memLimit).to.equal(
				68719476736,
			);
			expect(makeComposeServiceWithLimit('64Gb').config.memLimit).to.equal(
				68719476736,
			);
		});
	});

	describe('getWorkingDir', () => {
		const makeComposeServiceWithWorkdir = (workdir?: string) =>
			Service.fromComposeObject(
				{
					appId: 123456,
					serviceId: 123456,
					serviceName: 'foobar',
					workingDir: workdir,
				},
				{ appName: 'test' } as any,
			);

		it('should remove a trailing slash', () => {
			expect(
				makeComposeServiceWithWorkdir('/usr/src/app/').config.workingDir,
			).to.equal('/usr/src/app');
			expect(makeComposeServiceWithWorkdir('/').config.workingDir).to.equal(
				'/',
			);
			expect(
				makeComposeServiceWithWorkdir('/usr/src/app').config.workingDir,
			).to.equal('/usr/src/app');
			expect(makeComposeServiceWithWorkdir('').config.workingDir).to.equal('');
		});
	});

	describe('Docker <-> Compose config', () => {
		const omitConfigForComparison = (config: ServiceConfig) =>
			_.omit(config, ['running', 'networks']);

		it('should be identical when converting a simple service', () => {
			const composeSvc = Service.fromComposeObject(
				configs.simple.compose,
				configs.simple.imageInfo,
			);
			const dockerSvc = Service.fromDockerContainer(configs.simple.inspect);

			const composeConfig = omitConfigForComparison(composeSvc.config);
			const dockerConfig = omitConfigForComparison(dockerSvc.config);
			expect(composeConfig).to.deep.equal(dockerConfig);

			expect(dockerSvc.isEqualConfig(composeSvc, {})).to.be.true;
		});

		it('should correct convert formats with a null entrypoint', () => {
			const composeSvc = Service.fromComposeObject(
				configs.entrypoint.compose,
				configs.entrypoint.imageInfo,
			);
			const dockerSvc = Service.fromDockerContainer(configs.entrypoint.inspect);

			const composeConfig = omitConfigForComparison(composeSvc.config);
			const dockerConfig = omitConfigForComparison(dockerSvc.config);
			expect(composeConfig).to.deep.equal(dockerConfig);

			expect(dockerSvc.isEqualConfig(composeSvc, {})).to.equals(true);
		});

		describe('Networks', () => {
			it('should correctly convert networks from compose to docker format', () => {
				const makeComposeServiceWithNetwork = (
					networks: ServiceComposeConfig['networks'],
				) =>
					Service.fromComposeObject(
						{
							appId: 123456,
							serviceId: 123456,
							serviceName: 'test',
							networks,
						},
						{ appName: 'test' } as any,
					);

				expect(
					makeComposeServiceWithNetwork({
						balena: {
							ipv4Address: '1.2.3.4',
						},
					}).toDockerContainer({ deviceName: 'foo' } as any).NetworkingConfig,
				).to.deep.equal({
					EndpointsConfig: {
						'123456_balena': {
							IPAMConfig: {
								IPv4Address: '1.2.3.4',
							},
							Aliases: ['test'],
						},
					},
				});

				expect(
					makeComposeServiceWithNetwork({
						balena: {
							aliases: ['test', '1123'],
							ipv4Address: '1.2.3.4',
							ipv6Address: '5.6.7.8',
							linkLocalIps: ['123.123.123'],
						},
					}).toDockerContainer({ deviceName: 'foo' } as any).NetworkingConfig,
				).to.deep.equal({
					EndpointsConfig: {
						'123456_balena': {
							IPAMConfig: {
								IPv4Address: '1.2.3.4',
								IPv6Address: '5.6.7.8',
								LinkLocalIPs: ['123.123.123'],
							},
							Aliases: ['test', '1123'],
						},
					},
				});
			});

			it('should correctly convert Docker format to service format', () => {
				const dockerCfg = require('./data/docker-states/simple/inspect.json');

				const makeServiceFromDockerWithNetwork = (networks: {
					[name: string]: any;
				}) => {
					const newConfig = _.cloneDeep(dockerCfg);
					newConfig.NetworkSettings = {
						Networks: networks,
					};
					return Service.fromDockerContainer(newConfig);
				};

				expect(
					makeServiceFromDockerWithNetwork({
						'123456_balena': {
							IPAMConfig: {
								IPv4Address: '1.2.3.4',
							},
							Aliases: [],
						},
					}).config.networks,
				).to.deep.equal({
					'123456_balena': {
						ipv4Address: '1.2.3.4',
					},
				});

				expect(
					makeServiceFromDockerWithNetwork({
						'123456_balena': {
							IPAMConfig: {
								IPv4Address: '1.2.3.4',
								IPv6Address: '5.6.7.8',
								LinkLocalIps: ['123.123.123'],
							},
							Aliases: ['test', '1123'],
						},
					}).config.networks,
				).to.deep.equal({
					'123456_balena': {
						ipv4Address: '1.2.3.4',
						ipv6Address: '5.6.7.8',
						linkLocalIps: ['123.123.123'],
						aliases: ['test', '1123'],
					},
				});
			});
		});

		return describe('Network mode=service:', () => {
			it('should correctly add a depends_on entry for the service', () => {
				let s = Service.fromComposeObject(
					{
						appId: '1234',
						serviceName: 'foo',
						releaseId: 2,
						serviceId: 3,
						imageId: 4,
						network_mode: 'service: test',
					},
					{ appName: 'test' } as any,
				);

				expect(s.dependsOn).to.deep.equal(['test']);

				s = Service.fromComposeObject(
					{
						appId: '1234',
						serviceName: 'foo',
						releaseId: 2,
						serviceId: 3,
						imageId: 4,
						depends_on: ['another_service'],
						network_mode: 'service: test',
					},
					{ appName: 'test' } as any,
				);

				expect(s.dependsOn).to.deep.equal(['another_service', 'test']);
			});

			it('should correctly convert a network_mode service: to a container:', () => {
				const s = Service.fromComposeObject(
					{
						appId: '1234',
						serviceName: 'foo',
						releaseId: 2,
						serviceId: 3,
						imageId: 4,
						network_mode: 'service: test',
					},
					{ appName: 'test' } as any,
				);
				return expect(
					s.toDockerContainer({
						deviceName: '',
						containerIds: { test: 'abcdef' },
					}),
				)
					.to.have.property('HostConfig')
					.that.has.property('NetworkMode')
					.that.equals('container:abcdef');
			});

			it('should not cause a container restart if a service: container has not changed', () => {
				const composeSvc = Service.fromComposeObject(
					configs.networkModeService.compose,
					configs.networkModeService.imageInfo,
				);
				const dockerSvc = Service.fromDockerContainer(
					configs.networkModeService.inspect,
				);

				const composeConfig = omitConfigForComparison(composeSvc.config);
				const dockerConfig = omitConfigForComparison(dockerSvc.config);
				expect(composeConfig).to.not.deep.equal(dockerConfig);

				expect(dockerSvc.isEqualConfig(composeSvc, { test: 'abcdef' })).to.be
					.true;
			});

			it('should restart a container when its dependent network mode container changes', () => {
				const composeSvc = Service.fromComposeObject(
					configs.networkModeService.compose,
					configs.networkModeService.imageInfo,
				);
				const dockerSvc = Service.fromDockerContainer(
					configs.networkModeService.inspect,
				);

				const composeConfig = omitConfigForComparison(composeSvc.config);
				const dockerConfig = omitConfigForComparison(dockerSvc.config);
				expect(composeConfig).to.not.deep.equal(dockerConfig);

				return expect(dockerSvc.isEqualConfig(composeSvc, { test: 'qwerty' }))
					.to.be.false;
			});
		});
	});
});
