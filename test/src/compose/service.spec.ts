import * as _ from 'lodash';
import * as sinon from 'sinon';

import { expect } from 'chai';
import { createContainer } from '../../lib/mockerode';

import Service from '../../../src/compose/service';
import Volume from '../../../src/compose/volume';
import {
	ServiceComposeConfig,
	ServiceConfig,
} from '../../../src/compose/types/service';
import * as constants from '../../../src/lib/constants';
import * as apiKeys from '../../../src/lib/api-keys';

import log from '../../../src/lib/supervisor-console';

const configs = {
	simple: {
		compose: require('../../data/docker-states/simple/compose.json'),
		imageInfo: require('../../data/docker-states/simple/imageInfo.json'),
		inspect: require('../../data/docker-states/simple/inspect.json'),
	},
	entrypoint: {
		compose: require('../../data/docker-states/entrypoint/compose.json'),
		imageInfo: require('../../data/docker-states/entrypoint/imageInfo.json'),
		inspect: require('../../data/docker-states/entrypoint/inspect.json'),
	},
	networkModeService: {
		compose: require('../../data/docker-states/network-mode-service/compose.json'),
		imageInfo: require('../../data/docker-states/network-mode-service/imageInfo.json'),
		inspect: require('../../data/docker-states/network-mode-service/inspect.json'),
	},
};

describe('compose/service', () => {
	before(() => {
		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'success');
	});

	after(() => {
		sinon.restore();
	});

	describe('Creating a service instance from a compose object', () => {
		it('extends environment variables with additional OS info', async () => {
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
				appUuid: 'deadbeef',
				releaseId: 2,
				serviceId: 3,
				imageId: 4,
				serviceName: 'serviceName',
				environment: {
					FOO: 'bar',
					A_VARIABLE: 'ITS_VALUE',
				},
			};
			const s = await Service.fromComposeObject(
				service,
				extendEnvVarsOpts as any,
			);

			expect(s.config.environment).to.deep.equal({
				FOO: 'bar',
				A_VARIABLE: 'ITS_VALUE',
				RESIN_APP_ID: '23',
				RESIN_APP_UUID: 'deadbeef',
				RESIN_APP_NAME: 'awesomeApp',
				RESIN_DEVICE_UUID: '1234',
				RESIN_DEVICE_ARCH: 'amd64',
				RESIN_DEVICE_TYPE: 'raspberry-pi',
				RESIN_HOST_OS_VERSION: 'Resin OS 2.0.2',
				RESIN_SERVICE_NAME: 'serviceName',
				RESIN_APP_LOCK_PATH: '/tmp/balena/updates.lock',
				RESIN_SERVICE_KILL_ME_PATH: '/tmp/balena/handover-complete',
				RESIN: '1',
				BALENA_APP_ID: '23',
				BALENA_APP_UUID: 'deadbeef',
				BALENA_APP_NAME: 'awesomeApp',
				BALENA_DEVICE_UUID: '1234',
				BALENA_DEVICE_ARCH: 'amd64',
				BALENA_DEVICE_TYPE: 'raspberry-pi',
				BALENA_HOST_OS_VERSION: 'Resin OS 2.0.2',
				BALENA_SERVICE_NAME: 'serviceName',
				BALENA_APP_LOCK_PATH: '/tmp/balena/updates.lock',
				BALENA_SERVICE_HANDOVER_COMPLETE_PATH: '/tmp/balena/handover-complete',
				BALENA: '1',
				USER: 'root',
			});
		});

		it('returns the correct default bind mounts', async () => {
			const s = await Service.fromComposeObject(
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

		it('produces the correct port bindings and exposed ports', async () => {
			const s = await Service.fromComposeObject(
				{
					appId: '1234',
					serviceName: 'foo',
					releaseId: 2,
					serviceId: 3,
					imageId: 4,
					composition: {
						expose: [1000, '243/udp'],
						ports: ['2344', '2345:2354', '2346:2367/udp'],
					},
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

		it('correctly handles port ranges', async () => {
			const s = await Service.fromComposeObject(
				{
					appId: '1234',
					serviceName: 'foo',
					releaseId: 2,
					serviceId: 3,
					imageId: 4,
					composition: {
						expose: [1000, '243/udp'],
						ports: ['1000-1003:2000-2003'],
					},
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

		it('should correctly handle large port ranges', async function () {
			this.timeout(60000);
			const s = await Service.fromComposeObject(
				{
					appId: '1234',
					serviceName: 'foo',
					releaseId: 2,
					serviceId: 3,
					imageId: 4,
					composition: {
						ports: ['5-65536:5-65536/tcp', '5-65536:5-65536/udp'],
					},
				},
				{ appName: 'test' } as any,
			);

			expect((s as any).generateExposeAndPorts()).to.not.throw;
		});

		it('should correctly report implied exposed ports from portMappings', async () => {
			const service = await Service.fromComposeObject(
				{
					appId: 123456,
					serviceId: 123456,
					serviceName: 'test',
					composition: {
						ports: ['80:80', '100:100'],
					},
				},
				{ appName: 'test' } as any,
			);

			expect(service.config)
				.to.have.property('expose')
				.that.deep.equals(['80/tcp', '100/tcp']);
		});

		it('should correctly handle spaces in volume definitions', async () => {
			const service = await Service.fromComposeObject(
				{
					appId: 123,
					serviceId: 123,
					serviceName: 'test',
					composition: {
						volumes: [
							'vol1:vol2',
							'vol3 :/usr/src/app',
							'vol4: /usr/src/app',
							'vol5 : vol6',
						],
					},
				},
				{ appName: 'test' } as any,
			);

			expect(service.config)
				.to.have.property('volumes')
				.that.deep.equals([
					`${Volume.generateDockerName(123, 'vol1')}:vol2`,
					`${Volume.generateDockerName(123, 'vol3')}:/usr/src/app`,
					`${Volume.generateDockerName(123, 'vol4')}:/usr/src/app`,
					`${Volume.generateDockerName(123, 'vol5')}:vol6`,

					'/tmp/balena-supervisor/services/123/test:/tmp/resin',
					'/tmp/balena-supervisor/services/123/test:/tmp/balena',
				]);
		});

		describe('Parsing memory strings from compose configuration', () => {
			const makeComposeServiceWithLimit = async (memLimit?: string | number) =>
				await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						composition: {
							mem_limit: memLimit,
						},
					},
					{ appName: 'test' } as any,
				);

			it('should correctly parse memory number strings without a unit', async () =>
				expect(
					(await makeComposeServiceWithLimit('64')).config.memLimit,
				).to.equal(64));

			it('should correctly apply the default value', async () =>
				expect(
					(await makeComposeServiceWithLimit(undefined)).config.memLimit,
				).to.equal(0));

			it('should correctly support parsing numbers as memory limits', async () =>
				expect(
					(await makeComposeServiceWithLimit(64)).config.memLimit,
				).to.equal(64));

			it('should correctly parse memory number strings that use a byte unit', async () => {
				expect(
					(await makeComposeServiceWithLimit('64b')).config.memLimit,
				).to.equal(64);
				expect(
					(await makeComposeServiceWithLimit('64B')).config.memLimit,
				).to.equal(64);
			});

			it('should correctly parse memory number strings that use a kilobyte unit', async () => {
				expect(
					(await makeComposeServiceWithLimit('64k')).config.memLimit,
				).to.equal(65536);
				expect(
					(await makeComposeServiceWithLimit('64K')).config.memLimit,
				).to.equal(65536);

				expect(
					(await makeComposeServiceWithLimit('64kb')).config.memLimit,
				).to.equal(65536);
				expect(
					(await makeComposeServiceWithLimit('64Kb')).config.memLimit,
				).to.equal(65536);
			});

			it('should correctly parse memory number strings that use a megabyte unit', async () => {
				expect(
					(await makeComposeServiceWithLimit('64m')).config.memLimit,
				).to.equal(67108864);
				expect(
					(await makeComposeServiceWithLimit('64M')).config.memLimit,
				).to.equal(67108864);

				expect(
					(await makeComposeServiceWithLimit('64mb')).config.memLimit,
				).to.equal(67108864);
				expect(
					(await makeComposeServiceWithLimit('64Mb')).config.memLimit,
				).to.equal(67108864);
			});

			it('should correctly parse memory number strings that use a gigabyte unit', async () => {
				expect(
					(await makeComposeServiceWithLimit('64g')).config.memLimit,
				).to.equal(68719476736);
				expect(
					(await makeComposeServiceWithLimit('64G')).config.memLimit,
				).to.equal(68719476736);

				expect(
					(await makeComposeServiceWithLimit('64gb')).config.memLimit,
				).to.equal(68719476736);
				expect(
					(await makeComposeServiceWithLimit('64Gb')).config.memLimit,
				).to.equal(68719476736);
			});
		});

		describe('Getting work dir from the compose configuration', () => {
			const makeComposeServiceWithWorkdir = async (workdir?: string) =>
				await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						composition: {
							workingDir: workdir,
						},
					},
					{ appName: 'test' } as any,
				);

			it('should remove a trailing slash', async () => {
				expect(
					(await makeComposeServiceWithWorkdir('/usr/src/app/')).config
						.workingDir,
				).to.equal('/usr/src/app');
				expect(
					(await makeComposeServiceWithWorkdir('/')).config.workingDir,
				).to.equal('/');
				expect(
					(await makeComposeServiceWithWorkdir('/usr/src/app')).config
						.workingDir,
				).to.equal('/usr/src/app');
				expect(
					(await makeComposeServiceWithWorkdir('')).config.workingDir,
				).to.equal('');
			});
		});

		describe('Configuring service networks', () => {
			it('should correctly convert networks from compose to docker format', async () => {
				const makeComposeServiceWithNetwork = async (
					networks: ServiceComposeConfig['networks'],
				) =>
					await Service.fromComposeObject(
						{
							appId: 123456,
							appUuid: 'deadbeef',
							serviceId: 123456,
							serviceName: 'test',
							composition: {
								networks,
							},
						},
						{ appName: 'test' } as any,
					);

				expect(
					(
						await makeComposeServiceWithNetwork({
							balena: {
								ipv4Address: '1.2.3.4',
							},
						})
					).toDockerContainer({ deviceName: 'foo' } as any).NetworkingConfig,
				).to.deep.equal({
					EndpointsConfig: {
						deadbeef_balena: {
							IPAMConfig: {
								IPv4Address: '1.2.3.4',
							},
							Aliases: ['test'],
						},
					},
				});

				expect(
					(
						await makeComposeServiceWithNetwork({
							balena: {
								aliases: ['test', '1123'],
								ipv4Address: '1.2.3.4',
								ipv6Address: '5.6.7.8',
								linkLocalIps: ['123.123.123'],
							},
						})
					).toDockerContainer({ deviceName: 'foo' } as any).NetworkingConfig,
				).to.deep.equal({
					EndpointsConfig: {
						deadbeef_balena: {
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
		});
	});

	describe('Configuring service volumes', () => {
		it('should add bind mounts using the mounts API', async () => {
			const s = await Service.fromComposeObject(
				{
					appId: 123456,
					serviceId: 123456,
					serviceName: 'test',
					composition: {
						volumes: ['myvolume:/myvolume'],
						tmpfs: ['/var/tmp'],
					},
				},
				{ appName: 'test' } as any,
			);

			// inject bind mounts (as feature labels would)
			s.config.volumes.push('/sys:/sys:ro');
			s.config.volumes.push(
				`${constants.dockerSocket}:${constants.containerDockerSocket}`,
			);

			const c = s.toDockerContainer({ deviceName: 'foo' } as any);

			expect(c)
				.to.have.property('HostConfig')
				.that.has.property('Mounts')
				.that.deep.includes.members([
					{
						Type: 'volume',
						Source: Volume.generateDockerName(123456, 'myvolume'),
						Target: '/myvolume',
						ReadOnly: false,
					},
					{
						Type: 'bind',
						Source: '/tmp/balena-supervisor/services/123456/test',
						Target: '/tmp/resin',
						ReadOnly: false,
					},
					{
						Type: 'bind',
						Source: '/tmp/balena-supervisor/services/123456/test',
						Target: '/tmp/balena',
						ReadOnly: false,
					},
					{
						Type: 'bind',
						Source: '/sys',
						Target: '/sys',
						ReadOnly: true,
					},
					{
						Type: 'bind',
						Source: constants.dockerSocket,
						Target: constants.containerDockerSocket,
						ReadOnly: false,
					},
					{
						Type: 'tmpfs',
						Target: '/var/tmp',
					},
				]);
		});

		it('should obtain the service volume config from docker configuration', () => {
			const mockContainer = createContainer({
				Id: 'deadbeef',
				Name: 'main_431889_572579',
				HostConfig: {
					// Volumes with Bind configs are ignored since
					// the Supervisor uses explicit Mounts for volumes
					Binds: ['ignoredvolume:/ignoredvolume'],
					Tmpfs: {
						'/var/tmp1': '',
					},
					Mounts: [
						{
							Type: 'volume',
							Source: 'testvolume',
							Target: '/testvolume',
							ReadOnly: false,
						},
						{
							Type: 'bind',
							Source: '/proc',
							Target: '/proc',
							ReadOnly: true,
						},
						{
							Type: 'bind',
							Source: '/sys',
							Target: '/sys',
							ReadOnly: true,
						},
						{
							Type: 'volume',
							Source: 'anothervolume',
							Target: '/anothervolume',
							ReadOnly: false,
						},
						{
							Type: 'tmpfs',
							Source: '',
							Target: '/var/tmp2',
						},
					],
				},
				Config: {
					Volumes: {
						'/var/lib/volume': {},
					},
					Labels: {
						'io.resin.app-id': '1011165',
						'io.resin.architecture': 'armv7hf',
						'io.resin.service-id': '43697',
						'io.resin.service-name': 'main',
						'io.resin.supervised': 'true',
					},
				},
			});
			const s = Service.fromDockerContainer(mockContainer.inspectInfo);
			expect(s.config)
				.to.have.property('volumes')
				.that.deep.equals([
					'/var/lib/volume',
					'testvolume:/testvolume',
					'/proc:/proc:ro',
					'/sys:/sys:ro',
					'anothervolume:/anothervolume',
				]);
			expect(s.config)
				.to.have.property('tmpfs')
				.that.deep.equals(['/var/tmp1', '/var/tmp2']);
		});
	});

	describe('Comparing services', () => {
		describe('Comparing array parameters', () => {
			it('Should correctly compare ordered array parameters', async () => {
				const svc1 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							dns: ['8.8.8.8', '1.1.1.1'],
						},
					},
					{ appName: 'test' } as any,
				);
				let svc2 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							dns: ['8.8.8.8', '1.1.1.1'],
						},
					},
					{ appName: 'test' } as any,
				);
				expect(svc1.isEqualConfig(svc2, {})).to.be.true;

				svc2 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							dns: ['1.1.1.1', '8.8.8.8'],
						},
					},
					{ appName: 'test' } as any,
				);
				expect(!svc1.isEqualConfig(svc2, {})).to.be.true;
			});

			it('should correctly compare non-ordered array parameters', async () => {
				const svc1 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							volumes: ['abcdef', 'ghijk'],
						},
					},
					{ appName: 'test' } as any,
				);
				let svc2 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							volumes: ['abcdef', 'ghijk'],
						},
					},
					{ appName: 'test' } as any,
				);
				expect(svc1.isEqualConfig(svc2, {})).to.be.true;

				svc2 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							volumes: ['ghijk', 'abcdef'],
						},
					},
					{ appName: 'test' } as any,
				);
				expect(svc1.isEqualConfig(svc2, {})).to.be.true;
			});

			it('should correctly compare both ordered and non-ordered array parameters', async () => {
				const svc1 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							volumes: ['abcdef', 'ghijk'],
							dns: ['8.8.8.8', '1.1.1.1'],
						},
					},
					{ appName: 'test' } as any,
				);
				const svc2 = await Service.fromComposeObject(
					{
						appId: 1,
						serviceId: 1,
						serviceName: 'test',
						composition: {
							volumes: ['ghijk', 'abcdef'],
							dns: ['8.8.8.8', '1.1.1.1'],
						},
					},
					{ appName: 'test' } as any,
				);
				expect(svc1.isEqualConfig(svc2, {})).to.be.true;
			});
		});

		describe('Comparing volume bind mounts for services', () => {
			it('should distinguish between volumes using HostConfig.Mounts and HostConfig.Binds', async () => {
				const ctnWithBinds = await createContainer({
					Id: 'deadfeet',
					Name: 'main_1111_2222_abcd',
					HostConfig: {
						Binds: [
							'myvolume:/myvolume',
							'/tmp/balena-supervisor/services/1234567/main:/tmp/resin',
							'/tmp/balena-supervisor/services/1234567/main:/tmp/balena',
						],
					},
					Config: {
						Labels: {
							'io.resin.app-id': '1234567',
							'io.resin.architecture': 'amd64',
							'io.resin.service-id': '43697',
							'io.resin.service-name': 'main',
							'io.resin.supervised': 'true',
						},
					},
				});
				const svcWithBinds = await Service.fromDockerContainer(
					ctnWithBinds.inspectInfo,
				);

				const ctnWithMounts = await createContainer({
					Id: 'deadfeet',
					Name: 'main_1111_2222_abcd',
					HostConfig: {
						Mounts: [
							{
								Type: 'volume',
								Source: 'myvolume',
								Target: '/myvolume',
								ReadOnly: false,
							},
							{
								Type: 'bind',
								Source: '/tmp/balena-supervisor/services/1234567/main',
								Target: '/tmp/resin',
								ReadOnly: false,
							},
							{
								Type: 'bind',
								Source: '/tmp/balena-supervisor/services/1234567/main',
								Target: '/tmp/balena',
								ReadOnly: false,
							},
						],
					},
					Config: {
						Labels: {
							'io.resin.app-id': '1234567',
							'io.resin.architecture': 'amd64',
							'io.resin.service-id': '43697',
							'io.resin.service-name': 'main',
							'io.resin.supervised': 'true',
						},
					},
				});
				const svcWithMounts = await Service.fromDockerContainer(
					ctnWithMounts.inspectInfo,
				);

				expect(svcWithBinds.isEqualConfig(svcWithMounts, {})).to.be.false;
			});
		});
	});

	describe('Feature labels', () => {
		describe('io.balena.features.balena-socket', () => {
			it('should mount the socket in the container an set DOCKER_HOST with the proper location', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.balena-socket': '1',
						},
					},
					{ appName: 'test' } as any,
				);

				expect(service.config.volumes).to.include.members([
					`${constants.dockerSocket}:${constants.containerDockerSocket}`,
				]);

				expect(service.config.environment['DOCKER_HOST']).to.equal(
					`unix://${constants.containerDockerSocket}`,
				);
			});
		});

		describe('Features for mounting host directories (sys, dbus, proc, etc.)', () => {
			it('should add /run/dbus:/host/run/dbus to bind mounts when io.balena.features.dbus is used', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.dbus': '1',
						},
					},
					{ appName: 'test' } as any,
				);

				expect(service.config.volumes).to.include.members([
					'/run/dbus:/host/run/dbus',
				]);
			});

			it('should add `/sys` to the container bind mounts when io.balena.features.sysfs is used', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.sysfs': '1',
						},
					},
					{ appName: 'test' } as any,
				);

				expect(service.config.volumes).to.include.members(['/sys:/sys']);
			});

			it('should add `/proc` to the container bind mounts when io.balena.features.procfs is used', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.procfs': '1',
						},
					},
					{ appName: 'test' } as any,
				);

				expect(service.config.volumes).to.include.members(['/proc:/proc']);
			});

			it('should add `/lib/modules` to the container bind mounts when io.balena.features.kernel-modules is used (if the host path exists)', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.kernel-modules': '1',
						},
					},
					{
						appName: 'test',
						hostPathExists: {
							modules: true,
						},
					} as any,
				);

				expect(service.config.volumes).to.include.members([
					'/lib/modules:/lib/modules',
				]);
			});

			it('should NOT add `/lib/modules` to the container bind mounts when io.balena.features.kernel-modules is used (if the host path does NOT exist)', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.kernel-modules': '1',
						},
					},
					{
						appName: 'test',
						hostPathExists: {
							modules: false,
						},
					} as any,
				);

				expect(service.config.volumes).to.not.include.members([
					'/lib/modules:/lib/modules',
				]);
			});

			it('should add `/lib/firmware` to the container bind mounts when io.balena.features.firmware is used (if the host path exists)', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.firmware': '1',
						},
					},
					{
						appName: 'test',
						hostPathExists: {
							firmware: true,
						},
					} as any,
				);

				expect(service.config.volumes).to.include.members([
					'/lib/firmware:/lib/firmware',
				]);
			});

			it('should NOT add `/lib/firmware` to the container bind mounts when io.balena.features.firmware is used (if the host path does NOT exist)', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.firmware': '1',
						},
					},
					{
						appName: 'test',
						hostPathExists: {
							firmware: false,
						},
					} as any,
				);

				expect(service.config.volumes).to.not.include.members([
					'/lib/firmware:/lib/firmware',
				]);
			});
		});

		describe('io.balena.features.gpu', () => {
			const gpuDeviceRequest = {
				Driver: '',
				DeviceIDs: [],
				Count: 1,
				Capabilities: [['gpu']],
				Options: {},
			};
			it('should add GPU to compose configuration when the feature is set', async () => {
				const s = await Service.fromComposeObject(
					{
						appId: 123,
						serviceId: 123,
						serviceName: 'test',
						labels: {
							'io.balena.features.gpu': '1',
						},
					},
					{ appName: 'test' } as any,
				);

				expect(s.config)
					.to.have.property('deviceRequests')
					.that.deep.equals([gpuDeviceRequest]);
			});

			it('should obtain the GPU config from docker configuration', () => {
				const mockContainer = createContainer({
					Id: 'deadbeef',
					Name: 'main_431889_572579',
					HostConfig: {
						DeviceRequests: [gpuDeviceRequest],
					},
					Config: {
						Labels: {
							'io.resin.app-id': '1011165',
							'io.resin.architecture': 'armv7hf',
							'io.resin.service-id': '43697',
							'io.resin.service-name': 'main',
							'io.resin.supervised': 'true',
						},
					},
				});
				const s = Service.fromDockerContainer(mockContainer.inspectInfo);

				expect(s.config)
					.to.have.property('deviceRequests')
					.that.deep.equals([gpuDeviceRequest]);
			});
		});

		describe('io.balena.supervisor-api', () => {
			it('sets BALENA_SUPERVISOR_HOST, BALENA_SUPERVISOR_PORT and BALENA_SUPERVISOR_ADDRESS env vars', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.supervisor-api': '1',
						},
					},
					{
						appName: 'test',
						supervisorApiHost: 'supervisor',
						listenPort: 48484,
					} as any,
				);

				expect(
					service.config.environment['BALENA_SUPERVISOR_HOST'],
				).to.be.equal('supervisor');

				expect(
					service.config.environment['BALENA_SUPERVISOR_PORT'],
				).to.be.equal('48484');

				expect(
					service.config.environment['BALENA_SUPERVISOR_ADDRESS'],
				).to.be.equal('http://supervisor:48484');
			});

			it('sets BALENA_API_KEY env var to the scoped API key value', async () => {
				// TODO: should we add an integration test that checks that the value used for the API key comes
				// from the database
				sinon.stub(apiKeys, 'generateScopedKey').resolves('this is a secret');

				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.supervisor-api': '1',
						},
					},
					{
						appName: 'test',
						supervisorApiHost: 'supervisor',
						listenPort: 48484,
					} as any,
				);

				expect(
					service.config.environment['BALENA_SUPERVISOR_API_KEY'],
				).to.be.equal('this is a secret');

				(apiKeys.generateScopedKey as sinon.SinonStub).restore();
			});
		});
	});

	describe('Creating service instances from docker configuration', () => {
		const omitConfigForComparison = (config: ServiceConfig) =>
			_.omit(config, ['running', 'networks']);

		it('should be equivalent to loading from compose config for simple services', async () => {
			// TODO: improve the readability of this code
			const composeSvc = await Service.fromComposeObject(
				configs.simple.compose,
				configs.simple.imageInfo,
			);
			const dockerSvc = Service.fromDockerContainer(configs.simple.inspect);

			const composeConfig = omitConfigForComparison(composeSvc.config);
			const dockerConfig = omitConfigForComparison(dockerSvc.config);
			expect(composeConfig).to.deep.equal(dockerConfig);

			expect(dockerSvc.isEqualConfig(composeSvc, {})).to.be.true;
		});

		it('should correctly handle a null entrypoint', async () => {
			const composeSvc = await Service.fromComposeObject(
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
			it('should correctly convert Docker format to service format', () => {
				const { inspectInfo } = createContainer({
					Id: 'deadbeef',
					Name: 'main_431889_572579',
					Config: {
						Labels: {
							'io.resin.app-id': '1011165',
							'io.resin.architecture': 'armv7hf',
							'io.resin.service-id': '43697',
							'io.resin.service-name': 'main',
							'io.resin.supervised': 'true',
						},
					},
				});

				const makeServiceFromDockerWithNetwork = (networks: {
					[name: string]: any;
				}) => {
					return Service.fromDockerContainer({
						...inspectInfo,
						NetworkSettings: {
							...inspectInfo.NetworkSettings,
							Networks: networks,
						},
					});
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
	});

	describe('Network mode service:', () => {
		const omitConfigForComparison = (config: ServiceConfig) =>
			_.omit(config, ['running', 'networks']);

		it('should correctly add a depends_on entry for the service', async () => {
			let s = await Service.fromComposeObject(
				{
					appId: '1234',
					serviceName: 'foo',
					releaseId: 2,
					serviceId: 3,
					imageId: 4,
					composition: {
						network_mode: 'service: test',
					},
				},
				{ appName: 'test' } as any,
			);

			expect(s.dependsOn).to.deep.equal(['test']);

			s = await Service.fromComposeObject(
				{
					appId: '1234',
					serviceName: 'foo',
					releaseId: 2,
					serviceId: 3,
					imageId: 4,
					composition: {
						depends_on: ['another_service'],
						network_mode: 'service: test',
					},
				},
				{ appName: 'test' } as any,
			);

			expect(s.dependsOn).to.deep.equal(['another_service', 'test']);
		});

		it('should correctly convert a network_mode service: to a container:', async () => {
			const s = await Service.fromComposeObject(
				{
					appId: '1234',
					serviceName: 'foo',
					releaseId: 2,
					serviceId: 3,
					imageId: 4,
					composition: {
						network_mode: 'service: test',
					},
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

		it('should not cause a container restart if a service: container has not changed', async () => {
			const composeSvc = await Service.fromComposeObject(
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

		it('should restart a container when its dependent network mode container changes', async () => {
			const composeSvc = await Service.fromComposeObject(
				configs.networkModeService.compose,
				configs.networkModeService.imageInfo,
			);
			const dockerSvc = Service.fromDockerContainer(
				configs.networkModeService.inspect,
			);

			const composeConfig = omitConfigForComparison(composeSvc.config);
			const dockerConfig = omitConfigForComparison(dockerSvc.config);
			expect(composeConfig).to.not.deep.equal(dockerConfig);

			return expect(dockerSvc.isEqualConfig(composeSvc, { test: 'qwerty' })).to
				.be.false;
		});
	});

	describe('Security options', () => {
		it('ignores selinux security options on the target state', async () => {
			const service = await Service.fromComposeObject(
				{
					appId: 123,
					serviceId: 123,
					serviceName: 'test',
					composition: {
						securityOpt: [
							'label=user:USER',
							'label=user:ROLE',
							'seccomp=unconfined',
						],
					},
				},
				{ appName: 'test' } as any,
			);

			expect(service.config)
				.to.have.property('securityOpt')
				.that.deep.equals(['seccomp=unconfined']);
		});

		it('ignores selinux security options on the current state', async () => {
			const mockContainer = createContainer({
				Id: 'deadbeef',
				Name: 'main_431889_572579',
				Config: {
					Labels: {
						'io.resin.app-id': '1011165',
						'io.resin.architecture': 'armv7hf',
						'io.resin.service-id': '43697',
						'io.resin.service-name': 'main',
						'io.resin.supervised': 'true',
					},
				},
				HostConfig: {
					SecurityOpt: ['label=disable', 'seccomp=unconfined'],
				},
			});
			const service = Service.fromDockerContainer(
				await mockContainer.inspect(),
			);

			expect(service.config)
				.to.have.property('securityOpt')
				.that.deep.equals(['seccomp=unconfined']);
		});
	});
});
