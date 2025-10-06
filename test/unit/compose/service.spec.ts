import * as _ from 'lodash';
import type { SinonSpy } from 'sinon';

import { expect } from 'chai';
import { createContainer } from '~/test-lib/mockerode';

import { Service } from '~/src/compose/service';
import { Volume } from '~/src/compose/volume';
import * as ServiceT from '~/src/compose/types/service';
import * as constants from '~/lib/constants';
import log from '~/src/lib/supervisor-console';

const configs = {
	simple: {
		compose: require('~/test-data/docker-states/simple/compose.json'),
		imageInfo: require('~/test-data/docker-states/simple/imageInfo.json'),
		inspect: require('~/test-data/docker-states/simple/inspect.json'),
	},
	entrypoint: {
		compose: require('~/test-data/docker-states/entrypoint/compose.json'),
		imageInfo: require('~/test-data/docker-states/entrypoint/imageInfo.json'),
		inspect: require('~/test-data/docker-states/entrypoint/inspect.json'),
	},
	networkModeService: {
		compose: require('~/test-data/docker-states/network-mode-service/compose.json'),
		imageInfo: require('~/test-data/docker-states/network-mode-service/imageInfo.json'),
		inspect: require('~/test-data/docker-states/network-mode-service/inspect.json'),
	},
	init: {
		compose: require('~/test-data/docker-states/init/compose.json'),
		imageInfo: require('~/test-data/docker-states/init/imageInfo.json'),
		inspect: require('~/test-data/docker-states/init/inspect.json'),
	},
};

describe('compose/service: unit tests', () => {
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
						// This will be ignored
						expose: [1000, '243/udp'],
						ports: ['2344', '2345:2354', '2346:2367/udp'],
					},
				},
				{
					imageInfo: {
						Config: {
							ExposedPorts: {
								// This will be ignored by generateExposeAndPorts
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
			// Only exposes ports coming from the `ports`
			// property
			expect(ports.exposedPorts).to.deep.equal({
				'2344/tcp': {},
				'2354/tcp': {},
				'2367/udp': {},
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
				'2000/tcp': {},
				'2001/tcp': {},
				'2002/tcp': {},
				'2003/tcp': {},
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

		it('should support init property', async () => {
			const appConfigWithInit = (init?: boolean) => ({
				appId: 123,
				serviceId: 123,
				serviceName: 'test',
				composition: {
					init,
				},
			});
			const svc = await Service.fromComposeObject(appConfigWithInit(true), {
				appName: 'test',
			} as any);
			expect(svc.config).to.have.property('init').that.equals(true);

			const svc2 = await Service.fromComposeObject(appConfigWithInit(false), {
				appName: 'test',
			} as any);
			expect(svc2.config).to.have.property('init').that.equals(false);

			const svc3 = await Service.fromComposeObject(appConfigWithInit(), {
				appName: 'test',
			} as any);
			expect(svc3.config).to.not.have.property('init');
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
					networks: ServiceT.ServiceComposeConfig['networks'],
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

		it('should accept that target network aliases are a subset of current network aliases', async () => {
			const svc1 = await Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					composition: {
						networks: {
							test: {
								aliases: ['hello', 'world'],
							},
						},
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
						networks: {
							test: {
								aliases: ['hello', 'sweet', 'world'],
							},
						},
					},
				},
				{ appName: 'test' } as any,
			);

			// All aliases in target service (svc1) are contained in service 2
			expect(svc2.isEqualConfig(svc1, {})).to.be.true;
			// But the opposite is not true
			expect(svc1.isEqualConfig(svc2, {})).to.be.false;
		});

		it('should accept equal lists of network aliases', async () => {
			const svc1 = await Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					composition: {
						networks: {
							test: {
								aliases: ['hello', 'world'],
							},
						},
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
						networks: {
							test: {
								aliases: ['hello', 'world'],
							},
						},
					},
				},
				{ appName: 'test' } as any,
			);

			expect(svc1.isEqualConfig(svc2, {})).to.be.true;
			expect(svc2.isEqualConfig(svc1, {})).to.be.true;
		});

		it('should redact environment variables from debug logs when configs differ', async () => {
			const svc1 = await Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					environment: {
						SECRET_KEY: 'super-secret-value',
						API_TOKEN: 'sensitive-token',
					},
				},
				{ appName: 'test' } as any,
			);

			const svc2 = await Service.fromComposeObject(
				{
					appId: 1,
					serviceId: 1,
					serviceName: 'test',
					environment: {
						SECRET_KEY: 'different-secret',
						API_TOKEN: 'different-token',
						NEW_VAR: 'new-value',
					},
				},
				{ appName: 'test' } as any,
			);

			svc1.isEqualConfig(svc2, {});

			const debugSpy = log.debug as SinonSpy;
			const diffLog = debugSpy
				.getCalls()
				.map((call) => call.args.join(' '))
				.find((msg) => msg.includes('Non-array fields'));

			expect(diffLog).to.not.be.undefined;

			// Ensure sensitive values are not in the logs
			expect(diffLog).to.not.include('super-secret-value');
			expect(diffLog).to.not.include('sensitive-token');
			expect(diffLog).to.not.include('different-secret');
			expect(diffLog).to.not.include('different-token');
			expect(diffLog).to.not.include('new-value');

			// Ensure the redaction marker is present
			expect(diffLog).to.include('hidden');
		});
	});

	describe('Feature labels', () => {
		describe('io.balena.features.balena-socket', () => {
			it('should mount the socket in the container and set DOCKER_HOST with the proper location', async () => {
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

				expect(service.config.volumes).to.deep.include.members([
					{
						type: 'bind',
						source: constants.dockerSocket,
						target: constants.containerDockerSocket,
					},
					{
						type: 'bind',
						source: constants.dockerSocket,
						target: constants.dockerSocket,
					},
					{
						type: 'bind',
						source: constants.dockerSocket,
						target: '/var/run/balena.sock',
					},
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
	});

	describe('Creating service instances from docker configuration', () => {
		const omitConfigForComparison = (config: ServiceT.ServiceConfig) =>
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

		it('should correctly handle the init config', async () => {
			const composeSvc = await Service.fromComposeObject(
				configs.init.compose,
				configs.init.imageInfo,
			);
			const dockerSvc = Service.fromDockerContainer(configs.init.inspect);

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
							Aliases: ['test', '1123', 'deadbeef'],
						},
					}).config.networks,
				).to.deep.equal({
					'123456_balena': {
						ipv4Address: '1.2.3.4',
						ipv6Address: '5.6.7.8',
						linkLocalIps: ['123.123.123'],
						// The container id got removed from the alias list
						aliases: ['test', '1123'],
					},
				});
			});
		});
	});

	describe('Network mode service:', () => {
		const omitConfigForComparison = (config: ServiceT.ServiceConfig) =>
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

	describe('Long syntax volume configuration', () => {
		it('should generate a docker container config from a compose object (compose -> Service, Service -> container)', async () => {
			/**
			 * compose -> Service (fromComposeObject)
			 */
			const appId = 5;
			const serviceName = 'main';
			const longSyntaxVolumes = [
				// Long named volume
				{
					type: 'volume',
					source: 'another',
					target: '/another',
					readOnly: true,
				},
				// Long anonymous volume
				{
					type: 'volume',
					target: '/yet/another',
				},
				{ type: 'bind', source: '/mnt/data', target: '/data' },
				{ type: 'tmpfs', target: '/home/tmp' },
			];
			const service = await Service.fromComposeObject(
				{
					appId,
					serviceName,
					releaseId: 4,
					serviceId: 3,
					imageId: 2,
					composition: {
						volumes: [
							'myvolume:/myvolume',
							'readonly:/readonly:ro',
							'/home/mybind:/mybind',
							'anonymous_volume',
							...longSyntaxVolumes,
						],
						tmpfs: ['/var/tmp'],
					},
				},
				{ appName: 'bar' } as any,
			);

			// Only tmpfs from composition should be added to config.tmpfs
			expect(service.config.tmpfs).to.deep.equal(['/var/tmp']);
			// config.volumes should include all long syntax and short syntax mounts, excluding binds
			expect(service.config.volumes).to.deep.include.members([
				`${appId}_myvolume:/myvolume`,
				`${appId}_readonly:/readonly:ro`,
				'anonymous_volume',
				...longSyntaxVolumes.filter(({ type }) => type !== 'bind'),
				`/tmp/balena-supervisor/services/${appId}/${serviceName}:/tmp/resin`,
				`/tmp/balena-supervisor/services/${appId}/${serviceName}:/tmp/balena`,
			]);
			// bind mounts are not allowed
			expect(service.config.volumes).to.not.deep.include.members([
				'/home/mybind:/mybind',
				...longSyntaxVolumes.filter(({ type }) => type === 'bind'),
			]);

			/**
			 * Service -> container (toDockerContainer)
			 */
			// Inject bind mounts (as feature labels would)
			// Bind mounts added under feature labels use the short syntax, except for the engine label
			service.config.volumes.push('/var/log/journal:/var/log/journal:ro');
			service.config.volumes.push({
				type: 'bind',
				source: constants.dockerSocket,
				target: constants.containerDockerSocket,
			} as ServiceT.LongBind);

			const ctn = service.toDockerContainer({
				deviceName: 'thicc_nucc',
			} as any);
			// Only long syntax volumes should be listed under HostConfig.Mounts.
			// This includes any tmpfs volumes defined using long syntax, consistent
			// with docker-compose's behavior.
			expect(ctn.HostConfig)
				.to.have.property('Mounts')
				.that.deep.includes.members([
					{
						Type: 'volume',
						Source: `${appId}_another`, // Should be namespaced by appId
						Target: '/another',
						ReadOnly: true,
					},
					{ Type: 'tmpfs', Target: '/home/tmp' },
					{
						Type: 'bind',
						Source: constants.dockerSocket,
						Target: constants.containerDockerSocket,
					},
				]);

			// bind mounts except for the engine feature label should be filtered out
			expect(ctn.HostConfig)
				.to.have.property('Mounts')
				.that.does.not.deep.include.members([
					{ Type: 'bind', Source: '/mnt/data', Target: '/data' },
				]);

			// Short syntax volumes should be configured as HostConfig.Binds
			expect(ctn.HostConfig)
				.to.have.property('Binds')
				.that.includes.members([
					`${appId}_myvolume:/myvolume`,
					`${appId}_readonly:/readonly:ro`,
					`/tmp/balena-supervisor/services/${appId}/${serviceName}:/tmp/resin`,
					`/tmp/balena-supervisor/services/${appId}/${serviceName}:/tmp/balena`,
					'/var/log/journal:/var/log/journal:ro',
				]);

			// Tmpfs volumes defined through compose's service.tmpfs are under HostConfig.Tmpfs.
			// Otherwise tmpfs volumes defined through compose's service.volumes as type: 'tmpfs' are under HostConfig.Mounts.
			expect(ctn.HostConfig).to.have.property('Tmpfs').that.deep.equals({
				'/var/tmp': '',
			});
		});

		it('should generate a service instance from a docker container (container -> Service)', async () => {
			const appId = 6;
			const mockContainer = createContainer({
				Id: 'deadbeef',
				Name: 'main_123_456_789',
				HostConfig: {
					Binds: [
						`${appId}_test:/test`,
						`${appId}_test2:/test2:ro`,
						'/proc:/proc',
						'/etc/machine-id:/etc/machine-id:ro',
					],
					Tmpfs: {
						'/var/tmp1': '',
					},
					Mounts: [
						{
							Type: 'volume',
							Source: '6_test3',
							Target: '/test3',
						},
						{
							Type: 'tmpfs',
							Target: '/var/tmp2',
						} as any,
						// Dockerode typings require a Source field but tmpfs doesn't require Source
					],
				},
				Config: {
					Volumes: {
						'/var/lib/volume': {},
					},
					Labels: {
						'io.balena.app-id': `${appId}`,
						'io.balena.architecture': 'amd64',
						'io.balena.service-id': '123',
						'io.balena.service-name': 'main',
						'io.balena.supervised': 'true',
					},
				},
			});

			const service = Service.fromDockerContainer(mockContainer.inspectInfo);
			// service.volumes should combine:
			// - HostConfig.Binds
			// - 'volume'|'tmpfs' types from HostConfig.Mounts
			// - Config.Volumes
			expect(service.config)
				.to.have.property('volumes')
				.that.deep.includes.members([
					`${appId}_test:/test`,
					`${appId}_test2:/test2:ro`,
					'/proc:/proc',
					'/etc/machine-id:/etc/machine-id:ro',
					'/var/lib/volume',
					{
						type: 'volume',
						source: '6_test3',
						target: '/test3',
					},
					{
						type: 'tmpfs',
						target: '/var/tmp2',
					},
				]);

			// service.tmpfs should only include HostConfig.Tmpfs,
			// 'tmpfs' types defined with long syntax belong to HostConfig.Mounts
			// and therefore are added to service.config.volumes.
			expect(service.config)
				.to.have.property('tmpfs')
				.that.deep.equals(['/var/tmp1']);
		});
	});

	describe('Service volume types', () => {
		it('should correctly identify short syntax volumes', () => {
			// Short binds
			['/one:/one', '/two:/two:ro', '/three:/three:rw'].forEach((b) => {
				expect(ServiceT.ShortMount.is(b)).to.be.true;
				expect(ServiceT.ShortBind.is(b)).to.be.true;
				expect(ServiceT.ShortAnonymousVolume.is(b)).to.be.false;
				expect(ServiceT.ShortNamedVolume.is(b)).to.be.false;
			});
			// Short anonymous volumes
			['volume', 'another_volume'].forEach((v) => {
				expect(ServiceT.ShortMount.is(v)).to.be.false;
				expect(ServiceT.ShortBind.is(v)).to.be.false;
				expect(ServiceT.ShortAnonymousVolume.is(v)).to.be.true;
				expect(ServiceT.ShortNamedVolume.is(v)).to.be.false;
			});
			// Short named volumes
			[
				'another_one:/another/one',
				'yet_another:/yet/another:ro',
				'final:/final:rw',
			].forEach((v) => {
				expect(ServiceT.ShortMount.is(v)).to.be.true;
				expect(ServiceT.ShortBind.is(v)).to.be.false;
				expect(ServiceT.ShortAnonymousVolume.is(v)).to.be.false;
				expect(ServiceT.ShortNamedVolume.is(v)).to.be.true;
			});
		});

		it('should correctly identify long syntax volumes', () => {
			// For all the following examples where optionals are defined, only the option with key equal to the type
			// will be applied to the resulting volume, but the other options shouldn't cause the type check to return false.
			// For example, for a definition with { type: volume }, only { volume: { nocopy: boolean }} option will apply.
			const longAnonymousVols = [
				{ type: 'volume', target: '/one' },
				{ type: 'volume', target: '/two', readOnly: true },
				{ type: 'volume', target: '/three', volume: { nocopy: true } },
				{ type: 'volume', target: '/four', bind: { propagation: 'slave' } },
				{ type: 'volume', target: '/five', tmpfs: { size: 200 } },
			];
			longAnonymousVols.forEach((v) => {
				expect(ServiceT.LongAnonymousVolume.is(v)).to.be.true;
				expect(ServiceT.LongNamedVolume.is(v)).to.be.false;
				expect(ServiceT.LongBind.is(v)).to.be.false;
				expect(ServiceT.LongTmpfs.is(v)).to.be.false;
			});

			const longNamedVols = [
				{ type: 'volume', source: 'one', target: '/one' },
				{ type: 'volume', source: 'two', target: '/two', readOnly: false },
				{
					type: 'volume',
					source: 'three',
					target: '/three',
					volume: { nocopy: false },
				},
				{
					type: 'volume',
					source: 'four',
					target: '/four',
					bind: { propagation: 'slave' },
				},
				{
					type: 'volume',
					source: 'five',
					target: '/five',
					tmpfs: { size: 200 },
				},
			];
			longNamedVols.forEach((v) => {
				expect(ServiceT.LongAnonymousVolume.is(v)).to.be.false;
				expect(ServiceT.LongNamedVolume.is(v)).to.be.true;
				expect(ServiceT.LongBind.is(v)).to.be.false;
				expect(ServiceT.LongTmpfs.is(v)).to.be.false;
			});

			const longBinds = [
				{ type: 'bind', source: '/one', target: '/one' },
				{ type: 'bind', source: '/two', target: '/two', readOnly: true },
				{
					type: 'bind',
					source: '/three',
					target: '/three',
					volume: { nocopy: false },
				},
				{
					type: 'bind',
					source: '/four',
					target: '/four',
					bind: { propagation: 'slave' },
				},
				{
					type: 'bind',
					source: '/five',
					target: '/five',
					tmpfs: { size: 200 },
				},
			];
			longBinds.forEach((v) => {
				expect(ServiceT.LongAnonymousVolume.is(v)).to.be.false;
				expect(ServiceT.LongNamedVolume.is(v)).to.be.false;
				expect(ServiceT.LongBind.is(v)).to.be.true;
				expect(ServiceT.LongTmpfs.is(v)).to.be.false;
			});

			const longTmpfs = [
				{ type: 'tmpfs', target: '/var/tmp' },
				{ type: 'tmpfs', target: '/var/tmp2', readOnly: false },
				{ type: 'tmpfs', target: '/var/tmp3', volume: { nocopy: false } },
				{ type: 'tmpfs', target: '/var/tmp4', bind: { propagation: 'slave' } },
				{ type: 'tmpfs', target: '/var/tmp4', tmpfs: { size: 200 } },
			];
			longTmpfs.forEach((v) => {
				expect(ServiceT.LongAnonymousVolume.is(v)).to.be.false;
				expect(ServiceT.LongNamedVolume.is(v)).to.be.false;
				expect(ServiceT.LongBind.is(v)).to.be.false;
				expect(ServiceT.LongTmpfs.is(v)).to.be.true;
			});

			// All of the following volume definitions are not allowed by docker-compose
			const invalids = [
				// bind without source
				{ type: 'bind', target: '/test' },
				// bind with source that's not an absolute path
				{ type: 'bind', source: 'not_a_bind', target: '/bind' },
				// tmpfs with source
				{ type: 'tmpfs', source: '/var/tmp', target: '/home/tmp' },
				// Other types besides volume, tmpfs, or bind
				{ type: 'invalid', source: 'test', target: '/test2' },
			];
			invalids.forEach((v) => {
				expect(ServiceT.LongAnonymousVolume.is(v)).to.be.false;
				expect(ServiceT.LongNamedVolume.is(v)).to.be.false;
				expect(ServiceT.LongBind.is(v)).to.be.false;
				expect(ServiceT.LongTmpfs.is(v)).to.be.false;
			});
		});
	});
});
