import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import rewire = require('rewire');
import mockedAPI = require('./lib/mocked-device-api');

import * as dockerUtils from '../src/lib/docker-utils';
import {
	DeltaStillProcessingError,
	DockerDaemonError,
} from '../src/lib/errors';
import log from '../src/lib/supervisor-console';

describe('Deltas', () => {
	it('should correctly detect a V2 delta', async () => {
		const imageStub = stub(dockerUtils.docker, 'getImage').returns({
			inspect: () => {
				return Promise.resolve({
					Id:
						'sha256:34ec91fe6e08cb0f867bbc069c5f499d39297eb8e874bb8ce9707537d983bcbc',
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

	// Docker daemon errors that occur when applying a delta that is suddenly unavailable (deleted / modified)
	describe('Docker daemon errors', () => {
		const imageManager = rewire('../src/compose/images');

		class DockerDaemonErrorClass implements DockerDaemonError {
			public name = 'Error';
			constructor(
				public statusCode: number,
				public reason: string,
				public message: string,
			) {}
		}

		const image = mockedAPI.mockImage({ appId: 2 });

		const fetchOptions = {
			deltaSource: image.name,
			uuid: '1234567',
			currentApiKey: 'abcdefg',
			apiEndpoint: 'https://api.balena-cloud.com',
			deltaEndpoint: 'https://delta.balena-cloud.com',
			delta: true,
			deltaRequestTimeout: 30000,
			deltaApplyTimeout: 0,
			deltaRetryCount: 30,
			deltaRetryInterval: 10000,
			deltaVersion: 3,
		};

		before(() => {
			stub(log, 'debug');

			imageManager.__set__({
				markAsSupervised: async () => Promise.resolve(),
				fetchDelta: async () => {
					throw new DeltaStillProcessingError();
				},
				// When there's a daemon 404 image not found error, inspectByName in triggerFetch is the method that throws this error
				inspectByName: async () => {
					throw new DockerDaemonErrorClass(
						404,
						'no such image',
						`No such image: ${image.name}`,
					);
				},
			});
		});

		after(() => {
			(log.debug as SinonStub).restore();
		});

		it('should gracefully log Docker daemon 404 - no such image errors', async () => {
			await imageManager.triggerFetch(
				image,
				fetchOptions,
				() => {
					/* noop */
				},
				image.serviceName,
			);

			expect((log.debug as SinonStub).args[0][0]).to.equal(
				`Delta image has been modified or deleted by daemon while applying, redownloading: ${image.name}`,
			);
		});
	});
});
