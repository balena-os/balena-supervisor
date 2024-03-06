import { expect } from 'chai';
import { stub } from 'sinon';

import * as dockerUtils from '~/lib/docker-utils';
import { createDockerImage, cleanupDocker } from '~/test-lib/docker-helper';
import Docker from 'dockerode';

describe('lib/docker-utils', () => {
	const docker = new Docker();

	describe('getNetworkGateway', async () => {
		before(async () => {
			// Remove network if it already exists
			await cleanupDocker(docker);
			await docker.createNetwork({
				Name: 'supervisor0',
				Options: {
					'com.docker.network.bridge.name': 'supervisor0',
				},
				IPAM: {
					Driver: 'default',
					Config: [
						{
							Gateway: '10.105.0.1',
							Subnet: '10.105.0.0/16',
						},
					],
				},
			});
		});

		after(async () => {
			await cleanupDocker(docker);
		});

		// test using existing data...
		it('should return the correct gateway address for supervisor0', async () => {
			const gateway = await dockerUtils.getNetworkGateway('supervisor0');
			expect(gateway).to.equal('10.105.0.1');
		});

		it('should return the correct gateway address for host', async () => {
			const gateway = await dockerUtils.getNetworkGateway('host');
			expect(gateway).to.equal('127.0.0.1');
		});
	});

	describe('getImageEnv', () => {
		before(async () => {
			await createDockerImage('test-image', ['io.balena.testing=1'], docker, [
				'ENV TEST_VAR_1=1234',
				'ENV TEST_VAR_2=5678',
			]);
		});

		after(async () => {
			await docker.pruneImages({ filters: { dangling: { false: true } } });
		});

		// test using existing data...
		it('should return the correct image environment', async () => {
			const obj = await dockerUtils.getImageEnv('test-image');
			expect(obj).to.have.property('TEST_VAR_1').equal('1234');
			expect(obj).to.have.property('TEST_VAR_2').equal('5678');
		});
	});

	describe('isV2DeltaImage', () => {
		it('should correctly detect a V2 delta', async () => {
			// INFO: we still use the stub here. V2 deltas should eventually go away and there is no
			// really easy way to create a real image that simulates a v2 delta.
			const imageStub = stub(dockerUtils.docker, 'getImage').returns({
				inspect: () => {
					return Promise.resolve({
						Id: 'sha256:34ec91fe6e08cb0f867bbc069c5f499d39297eb8e874bb8ce9707537d983bcbc',
						RepoTags: [],
						RepoDigests: [],
						Parent: '',
						Comment: '',
						Created: '2019-12-05T10:20:51.516Z',
						Container: '',
						ContainerConfig: {
							Hostname: '',
							Domainname: '',
							User: '',
							AttachStdin: false,
							AttachStdout: false,
							AttachStderr: false,
							Tty: false,
							OpenStdin: false,
							StdinOnce: false,
							Env: null,
							Cmd: null,
							Image: '',
							Volumes: null,
							WorkingDir: '',
							Entrypoint: null,
							OnBuild: null,
							Labels: null,
						},
						DockerVersion: '',
						Author: '',
						Config: {
							Hostname: '7675a23f4fdc',
							Domainname: '',
							User: '',
							AttachStdin: false,
							AttachStdout: false,
							AttachStderr: false,
							Tty: false,
							OpenStdin: false,
							StdinOnce: false,
							Env: [
								'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
								'TINI_VERSION=0.14.0',
								'LC_ALL=C.UTF-8',
								'DEBIAN_FRONTEND=noninteractive',
								'UDEV=on',
								'container=docker',
								'test=123',
							],
							Cmd: [
								'/bin/sh',
								'-c',
								"while true; do echo 'hello'; sleep 10; done;",
							],
							ArgsEscaped: true,
							Image:
								'sha256:b24946093df7157727b20934d11a7287359d8de42d8a80030f51f46a73d645ec',
							Volumes: {
								'/sys/fs/cgroup': {},
							},
							WorkingDir: '',
							Entrypoint: ['/usr/bin/entry.sh'],
							OnBuild: [],
							Labels: {
								'io.resin.architecture': 'amd64',
								'io.resin.device-type': 'intel-nuc',
							},
							StopSignal: '37',
						},
						Architecture: '',
						Os: 'linux',
						Size: 17,
						VirtualSize: 17,
						GraphDriver: {
							Data: null,
							Name: 'aufs',
						},
						RootFS: {
							Type: 'layers',
							Layers: [
								'sha256:c6e6cd4f95ef00e62f5c9df5798393470c991ca0148cb1e434b28101ed4219d3',
							],
						},
						Metadata: {
							LastTagTime: '0001-01-01T00:00:00Z',
						},
					});
				},
			} as any);

			expect(await dockerUtils.isV2DeltaImage('test')).to.be.true;
			expect(imageStub.callCount).to.equal(1);
			imageStub.restore();
		});
	});
});
