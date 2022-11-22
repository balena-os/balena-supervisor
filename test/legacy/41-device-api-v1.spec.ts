import _ from 'lodash';
import { expect } from 'chai';
import {
	stub,
	spy,
	useFakeTimers,
	SinonStub,
	SinonSpy,
	SinonFakeTimers,
} from 'sinon';
import supertest from 'supertest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { exists, unlinkAll } from '~/lib/fs-utils';
import * as appMock from '~/test-lib/application-state-mock';
import * as mockedDockerode from '~/test-lib/mocked-dockerode';
import mockedAPI from '~/test-lib/mocked-device-api';
import sampleResponses from '~/test-data/device-api-responses.json';
import * as config from '~/src/config';
import * as logger from '~/src/logger';
import SupervisorAPI from '~/src/device-api';
import * as deviceApi from '~/src/device-api';
import * as apiBinder from '~/src/api-binder';
import * as deviceState from '~/src/device-state';
import * as apiKeys from '~/src/device-api/api-keys';
import * as dbus from '~/lib/dbus';
import * as updateLock from '~/lib/update-lock';
import * as TargetState from '~/src/device-state/target-state';
import * as targetStateCache from '~/src/device-state/target-state-cache';
import blink from '~/lib/blink';
import constants from '~/lib/constants';
import * as deviceAPIActions from '~/src/device-api/common';
import { UpdatesLockedError } from '~/lib/errors';
import { SchemaTypeKey } from '~/src/config/schema-type';
import log from '~/lib/supervisor-console';
import * as applicationManager from '~/src/compose/application-manager';
import App from '~/src/compose/app';

describe('SupervisorAPI [V1 Endpoints]', () => {
	let api: SupervisorAPI;
	let healthCheckStubs: SinonStub[];
	let targetStateCacheMock: SinonStub;
	const request = supertest(
		`http://127.0.0.1:${mockedAPI.mockedOptions.listenPort}`,
	);
	const services = [
		{ appId: 2, appUuid: 'deadbeef', serviceId: 640681, serviceName: 'one' },
		{ appId: 2, appUuid: 'deadbeef', serviceId: 640682, serviceName: 'two' },
		{ appId: 2, appUuid: 'deadbeef', serviceId: 640683, serviceName: 'three' },
	];
	const containers = services.map((service) => mockedAPI.mockService(service));
	const images = services.map((service) => mockedAPI.mockImage(service));

	let loggerStub: SinonStub;

	beforeEach(() => {
		// Mock a 3 container release
		appMock.mockManagers(containers, [], []);
		appMock.mockImages([], false, images);
		appMock.mockSupervisorNetwork(true);

		targetStateCacheMock.resolves({
			appId: 2,
			appUuid: 'deadbeef',
			commit: 'abcdef2',
			name: 'test-app2',
			source: 'https://api.balena-cloud.com',
			releaseId: 1232,
			services: JSON.stringify(services),
			networks: '[]',
			volumes: '[]',
		});
	});

	afterEach(() => {
		// Clear Dockerode actions recorded for each test
		mockedDockerode.resetHistory();
		appMock.unmockAll();
	});

	before(async () => {
		await apiBinder.initialized();
		await deviceState.initialized();
		await targetStateCache.initialized();

		// Do not apply target state
		stub(deviceState, 'applyStep').resolves();

		// Stub health checks so we can modify them whenever needed
		healthCheckStubs = [
			stub(apiBinder, 'healthcheck'),
			stub(deviceState, 'healthcheck'),
		];

		// The mockedAPI contains stubs that might create unexpected results
		// See the module to know what has been stubbed
		api = await mockedAPI.create(healthCheckStubs);

		// Start test API
		await api.listen(
			mockedAPI.mockedOptions.listenPort,
			mockedAPI.mockedOptions.timeout,
		);

		// Mock target state cache
		targetStateCacheMock = stub(targetStateCache, 'getTargetApp');

		// Stub logs for all API methods
		loggerStub = stub(logger, 'attach');
		loggerStub.resolves();
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e: any) {
			if (e.message !== 'Server is not running.') {
				throw e;
			}
		}
		(deviceState.applyStep as SinonStub).restore();
		// Restore healthcheck stubs
		healthCheckStubs.forEach((hc) => hc.restore());
		// Remove any test data generated
		await mockedAPI.cleanUp();
		targetStateCacheMock.restore();
		loggerStub.restore();
	});

	describe('POST /v1/restart', () => {
		it('restarts all containers in release', async () => {
			// Perform the test with our mocked release
			await mockedDockerode.testWithData({ containers, images }, async () => {
				// Perform test
				await request
					.post('/v1/restart')
					.send({ appId: 2 })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.POST['/restart'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V1.POST['/restart'].body,
						);
						expect(response.text).to.deep.equal(
							sampleResponses.V1.POST['/restart'].text,
						);
					});
				// Check that mockedDockerode contains 3 stop and start actions
				const removeSteps = _(mockedDockerode.actions)
					.pickBy({ name: 'stop' })
					.map()
					.value();
				expect(removeSteps).to.have.lengthOf(3);
				const startSteps = _(mockedDockerode.actions)
					.pickBy({ name: 'start' })
					.map()
					.value();
				expect(startSteps).to.have.lengthOf(3);
			});
		});

		it('validates request body parameters', async () => {
			await request
				.post('/v1/restart')
				.send({ thing: '' })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(sampleResponses.V1.POST['/restart [Invalid Body]'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V1.POST['/restart [Invalid Body]'].body,
					);
					expect(response.text).to.deep.equal(
						sampleResponses.V1.POST['/restart [Invalid Body]'].text,
					);
				});
		});
	});

	describe('GET /v1/healthy', () => {
		it('returns OK because all checks pass', async () => {
			// Make all healthChecks pass
			healthCheckStubs.forEach((hc) => hc.resolves(true));
			await request
				.get('/v1/healthy')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(sampleResponses.V1.GET['/healthy'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V1.GET['/healthy'].body,
					);
					expect(response.text).to.deep.equal(
						sampleResponses.V1.GET['/healthy'].text,
					);
				});
		});
		it('Fails because some checks did not pass', async () => {
			healthCheckStubs.forEach((hc) => hc.resolves(false));
			await request
				.get('/v1/healthy')
				.set('Accept', 'application/json')
				.expect(sampleResponses.V1.GET['/healthy [2]'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V1.GET['/healthy [2]'].body,
					);
					expect(response.text).to.deep.equal(
						sampleResponses.V1.GET['/healthy [2]'].text,
					);
				});
		});
	});

	describe('GET /v1/apps/:appId', () => {
		it('does not return information for an application when there is more than 1 container', async () => {
			await request
				.get('/v1/apps/2')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(
					sampleResponses.V1.GET['/apps/2 [Multiple containers running]']
						.statusCode,
				);
		});

		it('returns information about a specific application', async () => {
			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
				releaseId: 77777,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);
			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					// Make request
					await request
						.get('/v1/apps/2')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(sampleResponses.V1.GET['/apps/2'].statusCode)
						.expect('Content-Type', /json/)
						.then((response) => {
							expect(response.body).to.deep.equal(
								sampleResponses.V1.GET['/apps/2'].body,
							);
						});
				},
			);
		});
	});

	// TODO: setup for this test is wrong, which leads to inconsistent data being passed to
	// manager methods. A refactor is needed
	describe.skip('POST /v1/apps/:appId/stop', () => {
		it('does not allow stopping an application when there is more than 1 container', async () => {
			// Every test case in this suite has a 3 service release mocked so just make the request
			await mockedDockerode.testWithData({ containers, images }, async () => {
				await request
					.post('/v1/apps/2/stop')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(
						sampleResponses.V1.GET['/apps/2/stop [Multiple containers running]']
							.statusCode,
					);
			});
		});

		it('stops a SPECIFIC application and returns a containerId', async () => {
			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);
			// Perform the test with our mocked release
			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					await request
						.post('/v1/apps/2/stop')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(sampleResponses.V1.GET['/apps/2/stop'].statusCode)
						.expect('Content-Type', /json/)
						.then((response) => {
							expect(response.body).to.deep.equal(
								sampleResponses.V1.GET['/apps/2/stop'].body,
							);
						});
				},
			);
		});
	});

	// TODO: setup for this test is wrong, which leads to inconsistent data being passed to
	// manager methods. A refactor is needed
	describe.skip('POST /v1/apps/:appId/start', () => {
		it('does not allow starting an application when there is more than 1 container', async () => {
			// Every test case in this suite has a 3 service release mocked so just make the request
			await mockedDockerode.testWithData({ containers, images }, async () => {
				await request
					.post('/v1/apps/2/start')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(400);
			});
		});

		it('starts a SPECIFIC application and returns a containerId', async () => {
			const service = {
				serviceName: 'main',
				containerId: 'abc123',
				appId: 2,
				serviceId: 640681,
			};
			// Setup single container application
			const container = mockedAPI.mockService(service);
			const image = mockedAPI.mockImage(service);
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);

			// Target state returns single service
			targetStateCacheMock.resolves({
				appId: 2,
				commit: 'abcdef2',
				name: 'test-app2',
				source: 'https://api.balena-cloud.com',
				releaseId: 1232,
				services: JSON.stringify([service]),
				volumes: '[]',
				networks: '[]',
			});

			// Perform the test with our mocked release
			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					await request
						.post('/v1/apps/2/start')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(200)
						.expect('Content-Type', /json/)
						.then((response) => {
							expect(response.body).to.deep.equal({ containerId: 'abc123' });
						});
				},
			);
		});
	});

	describe('GET /v1/device', () => {
		it('returns MAC address', async () => {
			const response = await request
				.get('/v1/device')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);

			expect(response.body).to.have.property('mac_address').that.is.not.empty;
		});
	});

	describe('POST /v1/reboot', () => {
		let rebootMock: SinonStub;
		before(() => {
			rebootMock = stub(dbus, 'reboot').resolves((() => void 0) as any);
		});

		after(() => {
			rebootMock.restore();
		});

		afterEach(() => {
			rebootMock.resetHistory();
		});

		it('should return 202 and reboot if no locks are set', async () => {
			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
				releaseId: 77777,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);

			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					const response = await request
						.post('/v1/reboot')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(202);

					expect(response.body).to.have.property('Data').that.is.not.empty;
					expect(rebootMock).to.have.been.calledOnce;
				},
			);
		});

		it('should return 423 and reject the reboot if no locks are set', async () => {
			stub(updateLock, 'lock').callsFake(async (__, opts, fn) => {
				if (opts.force) {
					return fn();
				}
				throw new UpdatesLockedError('Updates locked');
			});

			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
				releaseId: 77777,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);

			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					const response = await request
						.post('/v1/reboot')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(423);

					expect(updateLock.lock).to.be.calledOnce;
					expect(response.body).to.have.property('Error').that.is.not.empty;
					expect(rebootMock).to.not.have.been.called;
				},
			);

			(updateLock.lock as SinonStub).restore();
		});

		it('should return 202 and reboot if force is set to true', async () => {
			stub(updateLock, 'lock').callsFake(async (__, opts, fn) => {
				if (opts.force) {
					return fn();
				}
				throw new UpdatesLockedError('Updates locked');
			});

			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
				releaseId: 77777,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);

			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					const response = await request
						.post('/v1/reboot')
						.send({ force: true })
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(202);

					expect(updateLock.lock).to.be.calledOnce;
					expect(response.body).to.have.property('Data').that.is.not.empty;
					expect(rebootMock).to.have.been.calledOnce;
				},
			);

			(updateLock.lock as SinonStub).restore();
		});
	});

	describe('POST /v1/shutdown', () => {
		let shutdownMock: SinonStub;
		before(() => {
			shutdownMock = stub(dbus, 'shutdown').resolves((() => void 0) as any);
		});

		after(async () => {
			shutdownMock.restore();
		});

		it('should return 202 and shutdown if no locks are set', async () => {
			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
				releaseId: 77777,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);

			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					const response = await request
						.post('/v1/shutdown')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(202);

					expect(response.body).to.have.property('Data').that.is.not.empty;
					expect(shutdownMock).to.have.been.calledOnce;
				},
			);

			shutdownMock.resetHistory();
		});

		it('should lock all applications before trying to shutdown', async () => {
			// Setup 2 applications running
			const twoContainers = [
				mockedAPI.mockService({
					containerId: 'abc123',
					appId: 1000,
					releaseId: 55555,
				}),
				mockedAPI.mockService({
					containerId: 'def456',
					appId: 2000,
					releaseId: 77777,
				}),
			];
			const twoImages = [
				mockedAPI.mockImage({
					appId: 1000,
				}),
				mockedAPI.mockImage({
					appId: 2000,
				}),
			];
			appMock.mockManagers(twoContainers, [], []);
			appMock.mockImages([], false, twoImages);

			const lockSpy = spy(updateLock, 'lock');
			await mockedDockerode.testWithData(
				{ containers: twoContainers, images: twoImages },
				async () => {
					const response = await request
						.post('/v1/shutdown')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(202);

					expect(lockSpy.callCount).to.equal(1);
					// Check that lock was passed both application Ids
					expect(lockSpy.lastCall.args[0]).to.deep.equal([1000, 2000]);
					expect(response.body).to.have.property('Data').that.is.not.empty;
					expect(shutdownMock).to.have.been.calledOnce;
				},
			);

			shutdownMock.resetHistory();
			lockSpy.restore();
		});

		it('should return 423 and reject the reboot if locks are set', async () => {
			stub(updateLock, 'lock').callsFake(async (__, opts, fn) => {
				if (opts.force) {
					return fn();
				}
				throw new UpdatesLockedError('Updates locked');
			});

			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
				releaseId: 77777,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);

			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					const response = await request
						.post('/v1/shutdown')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(423);

					expect(updateLock.lock).to.be.calledOnce;
					expect(response.body).to.have.property('Error').that.is.not.empty;
					expect(shutdownMock).to.not.have.been.called;
				},
			);

			(updateLock.lock as SinonStub).restore();
		});

		it('should return 202 and shutdown if force is set to true', async () => {
			stub(updateLock, 'lock').callsFake(async (__, opts, fn) => {
				if (opts.force) {
					return fn();
				}
				throw new UpdatesLockedError('Updates locked');
			});

			// Setup single container application
			const container = mockedAPI.mockService({
				containerId: 'abc123',
				appId: 2,
				releaseId: 77777,
			});
			const image = mockedAPI.mockImage({
				appId: 2,
			});
			appMock.mockManagers([container], [], []);
			appMock.mockImages([], false, [image]);

			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					const response = await request
						.post('/v1/shutdown')
						.send({ force: true })
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(202);

					expect(updateLock.lock).to.be.calledOnce;
					expect(response.body).to.have.property('Data').that.is.not.empty;
					expect(shutdownMock).to.have.been.calledOnce;
				},
			);

			(updateLock.lock as SinonStub).restore();
		});
	});

	describe('POST /v1/update', () => {
		let configStub: SinonStub;
		let targetUpdateSpy: SinonSpy;
		let readyForUpdatesStub: SinonStub;

		before(() => {
			configStub = stub(config, 'get');
			targetUpdateSpy = spy(TargetState, 'update');
			readyForUpdatesStub = stub(apiBinder, 'isReadyForUpdates').returns(true);
		});

		afterEach(() => {
			targetUpdateSpy.resetHistory();
		});

		after(() => {
			configStub.restore();
			targetUpdateSpy.restore();
			readyForUpdatesStub.restore();
		});

		it('returns 204 with no parameters', async () => {
			// Stub response for getting instantUpdates
			configStub.resolves(true);
			// Make request
			await request
				.post('/v1/update')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(sampleResponses.V1.POST['/update [204 Response]'].statusCode);
			// Check that TargetState.update was called
			expect(targetUpdateSpy).to.be.called;
			expect(targetUpdateSpy).to.be.calledWith(undefined, true);
		});

		it('returns 204 with force: true in body', async () => {
			// Stub response for getting instantUpdates
			configStub.resolves(true);
			// Make request with force: true in the body
			await request
				.post('/v1/update')
				.send({ force: true })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(sampleResponses.V1.POST['/update [204 Response]'].statusCode);
			// Check that TargetState.update was called
			expect(targetUpdateSpy).to.be.called;
			expect(targetUpdateSpy).to.be.calledWith(true, true);
		});

		it('returns 202 when instantUpdates are disabled', async () => {
			// Stub response for getting instantUpdates
			configStub.resolves(false);
			// Make request
			await request
				.post('/v1/update')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(sampleResponses.V1.POST['/update [202 Response]'].statusCode);
			// Check that TargetState.update was not called
			expect(targetUpdateSpy).to.not.be.called;
		});
	});

	describe('POST /v1/blink', () => {
		// Further blink function-specific testing located in 07-blink.spec.ts
		it('responds with code 200 and empty body', async () => {
			await request
				.post('/v1/blink')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(sampleResponses.V1.POST['/blink'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V1.POST['/blink'].body,
					);
					expect(response.text).to.deep.equal(
						sampleResponses.V1.POST['/blink'].text,
					);
				});
		});

		it('directs device to blink for 15000ms (hardcoded length)', async () => {
			const blinkStartSpy: SinonSpy = spy(blink.pattern, 'start');
			const blinkStopSpy: SinonSpy = spy(blink.pattern, 'stop');
			const clock: SinonFakeTimers = useFakeTimers();

			await request
				.post('/v1/blink')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.then(() => {
					expect(blinkStartSpy.callCount).to.equal(1);
					clock.tick(15000);
					expect(blinkStopSpy.callCount).to.equal(1);
				});

			blinkStartSpy.restore();
			blinkStopSpy.restore();
			clock.restore();
		});
	});

	describe('POST /v1/regenerate-api-key', () => {
		it('returns a valid new API key', async () => {
			const refreshKeySpy: SinonSpy = spy(apiKeys, 'refreshKey');

			let newKey: string = '';

			await request
				.post('/v1/regenerate-api-key')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(sampleResponses.V1.POST['/regenerate-api-key'].statusCode)
				.then((response) =>
					Promise.all([response, deviceApi.getGlobalApiKey()]),
				)
				.then(([response, globalApiKey]) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V1.POST['/regenerate-api-key'].body,
					);
					expect(response.text).to.equal(globalApiKey);
					newKey = response.text;
					expect(refreshKeySpy.callCount).to.equal(1);
				});

			// Ensure persistence with future calls
			await request
				.post('/v1/blink')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${newKey}`)
				.expect(sampleResponses.V1.POST['/blink'].statusCode);

			refreshKeySpy.restore();
		});

		it('expires old API key after generating new key', async () => {
			const oldKey: string = await deviceApi.getGlobalApiKey();

			await request
				.post('/v1/regenerate-api-key')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${oldKey}`)
				.expect(sampleResponses.V1.POST['/regenerate-api-key'].statusCode);

			await request
				.post('/v1/restart')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${oldKey}`)
				.expect(401);
		});

		it('communicates the new API key to balena API', async () => {
			const reportStateSpy: SinonSpy = spy(deviceState, 'reportCurrentState');

			await request
				.post('/v1/regenerate-api-key')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.then(() => {
					expect(reportStateSpy.callCount).to.equal(1);
					// Further reportCurrentState tests should be in 05-device-state.spec.ts,
					// but its test case seems to currently be skipped until interface redesign
				});

			reportStateSpy.restore();
		});
	});

	describe('/v1/device/host-config', () => {
		// Wrap GET and PATCH /v1/device/host-config tests in the same block to share
		// common scoped variables, namely file paths and file content
		const hostnamePath: string = path.join(
			process.env.ROOT_MOUNTPOINT!,
			'/etc/hostname',
		);
		const proxyBasePath: string = path.join(
			process.env.ROOT_MOUNTPOINT!,
			process.env.BOOT_MOUNTPOINT!,
			'system-proxy',
		);
		const redsocksPath: string = path.join(proxyBasePath, 'redsocks.conf');
		const noProxyPath: string = path.join(proxyBasePath, 'no_proxy');

		/**
		 * Copies contents of hostname, redsocks.conf, and no_proxy test files with `.template`
		 * endings to test files without `.template` endings to ensure the same data always
		 * exists for /v1/device/host-config test suites
		 */
		const restoreConfFileTemplates = async (): Promise<void[]> => {
			return Promise.all([
				fs.writeFile(
					hostnamePath,
					await fs.readFile(`${hostnamePath}.template`),
				),
				fs.writeFile(
					redsocksPath,
					await fs.readFile(`${redsocksPath}.template`),
				),
				fs.writeFile(noProxyPath, await fs.readFile(`${noProxyPath}.template`)),
			]);
		};

		// Set hostname & proxy file content to expected defaults
		before(async () => await restoreConfFileTemplates());
		afterEach(async () => await restoreConfFileTemplates());

		// Store GET responses for endpoint in variables so we can be less verbose in tests
		const hostnameOnlyRes =
			sampleResponses.V1.GET['/device/host-config [Hostname only]'];
		const hostnameProxyRes =
			sampleResponses.V1.GET['/device/host-config [Hostname and proxy]'];

		describe('GET /v1/device/host-config', () => {
			it('returns current host config (hostname and proxy)', async () => {
				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(hostnameProxyRes.statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(hostnameProxyRes.body);
					});
			});

			it('returns current host config (hostname only)', async () => {
				await unlinkAll(redsocksPath, noProxyPath);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(hostnameOnlyRes.statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(hostnameOnlyRes.body);
					});
			});

			it('errors if no hostname file exists', async () => {
				await unlinkAll(hostnamePath);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(503);
			});
		});

		describe('PATCH /v1/device/host-config', () => {
			let configSetStub: SinonStub;
			let logWarnStub: SinonStub;
			let restartServiceSpy: SinonSpy;

			const validProxyReqs: { [key: string]: number[] | string[] } = {
				ip: ['proxy.example.org', 'proxy.foo.org'],
				port: [5128, 1080],
				type: constants.validRedsocksProxyTypes,
				login: ['user', 'user2'],
				password: ['foo', 'bar'],
			};

			// Mock to short-circuit config.set, allowing writing hostname directly to test file
			const configSetFakeFn = async <T extends SchemaTypeKey>(
				keyValues: config.ConfigMap<T>,
			): Promise<void> =>
				await fs.writeFile(hostnamePath, (keyValues as any).hostname);

			const validatePatchResponse = (res: supertest.Response): void => {
				expect(res.text).to.equal(
					sampleResponses.V1.PATCH['/host/device-config'].text,
				);
				expect(res.body).to.deep.equal(
					sampleResponses.V1.PATCH['/host/device-config'].body,
				);
			};

			before(() => {
				configSetStub = stub(config, 'set').callsFake(configSetFakeFn);
				logWarnStub = stub(log, 'warn');
				stub(applicationManager, 'getCurrentApps').resolves({
					'1234567': new App(
						{
							appId: 1234567,
							services: [],
							volumes: {},
							networks: {},
						},
						false,
					),
				});
			});

			after(() => {
				configSetStub.restore();
				logWarnStub.restore();
				(applicationManager.getCurrentApps as SinonStub).restore();
			});

			beforeEach(() => {
				restartServiceSpy = spy(dbus, 'restartService');
			});

			afterEach(() => {
				restartServiceSpy.restore();
			});

			it('prevents patch if update locks are present', async () => {
				stub(updateLock, 'lock').callsFake(async (__, opts, fn) => {
					if (opts.force) {
						return fn();
					}
					throw new UpdatesLockedError('Updates locked');
				});

				await request
					.patch('/v1/device/host-config')
					.send({ network: { hostname: 'foobaz' } })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(423);

				expect(updateLock.lock).to.be.calledOnce;
				(updateLock.lock as SinonStub).restore();

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.then((response) => {
						expect(response.body.network.hostname).to.deep.equal(
							'foobardevice',
						);
					});
			});

			it('allows patch while update locks are present if force is in req.body', async () => {
				stub(updateLock, 'lock').callsFake(async (__, opts, fn) => {
					if (opts.force) {
						return fn();
					}
					throw new UpdatesLockedError('Updates locked');
				});

				await request
					.patch('/v1/device/host-config')
					.send({ network: { hostname: 'foobaz' }, force: true })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(200);

				expect(updateLock.lock).to.be.calledOnce;
				(updateLock.lock as SinonStub).restore();

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.then((response) => {
						expect(response.body.network.hostname).to.deep.equal('foobaz');
					});
			});

			it('updates the hostname with provided string if string is not empty', async () => {
				// stub servicePartOf to throw exceptions for the new service names
				stub(dbus, 'servicePartOf').callsFake(
					async (serviceName: string): Promise<string> => {
						if (serviceName === 'balena-hostname') {
							throw new Error('Unit not loaded.');
						}
						return '';
					},
				);
				await unlinkAll(redsocksPath, noProxyPath);

				const patchBody = { network: { hostname: 'newdevice' } };

				await request
					.patch('/v1/device/host-config')
					.send(patchBody)
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.PATCH['/host/device-config'].statusCode)
					.then((response) => {
						validatePatchResponse(response);
					});

				// should restart services
				expect(restartServiceSpy.callCount).to.equal(2);
				expect(restartServiceSpy.args).to.deep.equal([
					['balena-hostname'],
					['resin-hostname'],
				]);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.then((response) => {
						expect(response.body).to.deep.equal(patchBody);
					});

				(dbus.servicePartOf as SinonStub).restore();
			});

			it('skips restarting hostname services if they are part of config-json.target', async () => {
				// stub servicePartOf to return the config-json.target we are looking for
				stub(dbus, 'servicePartOf').callsFake(async (): Promise<string> => {
					return 'config-json.target';
				});

				await unlinkAll(redsocksPath, noProxyPath);

				const patchBody = { network: { hostname: 'newdevice' } };

				await request
					.patch('/v1/device/host-config')
					.send(patchBody)
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.PATCH['/host/device-config'].statusCode)
					.then((response) => {
						validatePatchResponse(response);
					});

				// skips restarting hostname services if they are part of config-json.target
				expect(restartServiceSpy.callCount).to.equal(0);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.then((response) => {
						expect(response.body).to.deep.equal(patchBody);
					});

				(dbus.servicePartOf as SinonStub).restore();
			});

			it('updates hostname to first 7 digits of device uuid when sent invalid hostname', async () => {
				await unlinkAll(redsocksPath, noProxyPath);
				await request
					.patch('/v1/device/host-config')
					.send({ network: { hostname: '' } })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.PATCH['/host/device-config'].statusCode)
					.then((response) => {
						validatePatchResponse(response);
					});

				// should restart services
				expect(restartServiceSpy.callCount).to.equal(2);
				expect(restartServiceSpy.args).to.deep.equal([
					['balena-hostname'],
					['resin-hostname'],
				]);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.then(async (response) => {
						const uuidHostname = await config
							.get('uuid')
							.then((uuid) => uuid?.slice(0, 7));

						expect(response.body).to.deep.equal({
							network: { hostname: uuidHostname },
						});
					});
			});

			it('removes proxy when sent empty proxy object', async () => {
				await request
					.patch('/v1/device/host-config')
					.send({ network: { proxy: {} } })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.PATCH['/host/device-config'].statusCode)
					.then(async (response) => {
						validatePatchResponse(response);

						expect(await exists(redsocksPath)).to.be.false;
						expect(await exists(noProxyPath)).to.be.false;
					});

				// should restart services
				expect(restartServiceSpy.callCount).to.equal(3);
				expect(restartServiceSpy.args).to.deep.equal([
					['balena-proxy-config'],
					['resin-proxy-config'],
					['redsocks'],
				]);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(hostnameOnlyRes.statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(hostnameOnlyRes.body);
					});
			});

			it('updates proxy type when provided valid values', async () => {
				// stub servicePartOf to throw exceptions for the new service names
				stub(dbus, 'servicePartOf').callsFake(
					async (serviceName: string): Promise<string> => {
						if (serviceName === 'balena-proxy-config') {
							throw new Error('Unit not loaded.');
						}
						return '';
					},
				);
				// Test each proxy patch sequentially to prevent conflicts when writing to fs
				let restartCallCount = 0;
				for (const key of Object.keys(validProxyReqs)) {
					const patchBodyValuesforKey: string[] | number[] =
						validProxyReqs[key];
					for (const value of patchBodyValuesforKey) {
						await request
							.patch('/v1/device/host-config')
							.send({ network: { proxy: { [key]: value } } })
							.set('Accept', 'application/json')
							.set(
								'Authorization',
								`Bearer ${await deviceApi.getGlobalApiKey()}`,
							)
							.expect(
								sampleResponses.V1.PATCH['/host/device-config'].statusCode,
							)
							.then((response) => {
								validatePatchResponse(response);
							});

						// should restart services
						expect(restartServiceSpy.callCount).to.equal(
							++restartCallCount * 3,
						);

						await request
							.get('/v1/device/host-config')
							.set('Accept', 'application/json')
							.set(
								'Authorization',
								`Bearer ${await deviceApi.getGlobalApiKey()}`,
							)
							.expect(hostnameProxyRes.statusCode)
							.then((response) => {
								expect(response.body).to.deep.equal({
									network: {
										hostname: hostnameProxyRes.body.network.hostname,
										// All other proxy configs should be unchanged except for any values sent in patch
										proxy: {
											...hostnameProxyRes.body.network.proxy,
											[key]: value,
										},
									},
								});
							});
					} // end for (const value of patchBodyValuesforKey)
					await restoreConfFileTemplates();
				} // end for (const key in validProxyReqs)
				(dbus.servicePartOf as SinonStub).restore();
			});

			it('skips restarting proxy services when part of redsocks-conf.target', async () => {
				// stub servicePartOf to return the redsocks-conf.target we are looking for
				stub(dbus, 'servicePartOf').callsFake(async (): Promise<string> => {
					return 'redsocks-conf.target';
				});
				// Test each proxy patch sequentially to prevent conflicts when writing to fs
				for (const key of Object.keys(validProxyReqs)) {
					const patchBodyValuesforKey: string[] | number[] =
						validProxyReqs[key];
					for (const value of patchBodyValuesforKey) {
						await request
							.patch('/v1/device/host-config')
							.send({ network: { proxy: { [key]: value } } })
							.set('Accept', 'application/json')
							.set(
								'Authorization',
								`Bearer ${await deviceApi.getGlobalApiKey()}`,
							)
							.expect(
								sampleResponses.V1.PATCH['/host/device-config'].statusCode,
							)
							.then((response) => {
								validatePatchResponse(response);
							});

						// skips restarting proxy services when part of redsocks-conf.target
						expect(restartServiceSpy.callCount).to.equal(0);

						await request
							.get('/v1/device/host-config')
							.set('Accept', 'application/json')
							.set(
								'Authorization',
								`Bearer ${await deviceApi.getGlobalApiKey()}`,
							)
							.expect(hostnameProxyRes.statusCode)
							.then((response) => {
								expect(response.body).to.deep.equal({
									network: {
										hostname: hostnameProxyRes.body.network.hostname,
										// All other proxy configs should be unchanged except for any values sent in patch
										proxy: {
											...hostnameProxyRes.body.network.proxy,
											[key]: value,
										},
									},
								});
							});
					} // end for (const value of patchBodyValuesforKey)
					await restoreConfFileTemplates();
				} // end for (const key in validProxyReqs)
				(dbus.servicePartOf as SinonStub).restore();
			});

			it('warns on the supervisor console when provided disallowed proxy fields', async () => {
				const invalidProxyReqs: { [key: string]: string | number } = {
					// At this time, don't support changing local_ip or local_port
					local_ip: '0.0.0.0',
					local_port: 12345,
					type: 'invalidType',
					noProxy: 'not a list of addresses',
				};

				for (const key of Object.keys(invalidProxyReqs)) {
					await request
						.patch('/v1/device/host-config')
						.send({ network: { proxy: { [key]: invalidProxyReqs[key] } } })
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
						.expect(200)
						.then(() => {
							if (key === 'type') {
								expect(logWarnStub).to.have.been.calledWith(
									`Invalid redsocks proxy type, must be one of ${validProxyReqs.type.join(
										', ',
									)}`,
								);
							} else if (key === 'noProxy') {
								expect(logWarnStub).to.have.been.calledWith(
									'noProxy field must be an array of addresses',
								);
							} else {
								expect(logWarnStub).to.have.been.calledWith(
									`Invalid proxy field(s): ${key}`,
								);
							}
						});
				}
			});

			it('replaces no_proxy file with noProxy array from PATCH body', async () => {
				await request
					.patch('/v1/device/host-config')
					.send({ network: { proxy: { noProxy: ['1.2.3.4/5'] } } })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.PATCH['/host/device-config'].statusCode)
					.then((response) => {
						validatePatchResponse(response);
					});

				// should restart services
				expect(restartServiceSpy.callCount).to.equal(3);
				expect(restartServiceSpy.args).to.deep.equal([
					['balena-proxy-config'],
					['resin-proxy-config'],
					['redsocks'],
				]);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(hostnameProxyRes.statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal({
							network: {
								hostname: hostnameProxyRes.body.network.hostname,
								// New noProxy should be only value in no_proxy file
								proxy: {
									...hostnameProxyRes.body.network.proxy,
									noProxy: ['1.2.3.4/5'],
								},
							},
						});
					});
			});

			it('removes no_proxy file when sent an empty array', async () => {
				await request
					.patch('/v1/device/host-config')
					.send({ network: { proxy: { noProxy: [] } } })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.PATCH['/host/device-config'].statusCode)
					.then((response) => {
						validatePatchResponse(response);
					});

				// should restart services
				expect(restartServiceSpy.callCount).to.equal(3);
				expect(restartServiceSpy.args).to.deep.equal([
					['balena-proxy-config'],
					['resin-proxy-config'],
					['redsocks'],
				]);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(hostnameProxyRes.statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal({
							network: {
								hostname: hostnameProxyRes.body.network.hostname,
								// Reference all properties in proxy object EXCEPT noProxy
								proxy: {
									ip: hostnameProxyRes.body.network.proxy.ip,
									login: hostnameProxyRes.body.network.proxy.login,
									password: hostnameProxyRes.body.network.proxy.password,
									port: hostnameProxyRes.body.network.proxy.port,
									type: hostnameProxyRes.body.network.proxy.type,
								},
							},
						});
					});
			});

			it('does not update hostname or proxy when hostname or proxy are undefined', async () => {
				await request
					.patch('/v1/device/host-config')
					.send({ network: {} })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.PATCH['/host/device-config'].statusCode)
					.then((response) => {
						validatePatchResponse(response);
					});

				// As no host configs were patched, no services should be restarted
				expect(restartServiceSpy.callCount).to.equal(0);

				await request
					.get('/v1/device/host-config')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(hostnameProxyRes.statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(hostnameProxyRes.body);
					});
			});

			it('warns on console when sent a malformed patch body', async () => {
				await request
					.patch('/v1/device/host-config')
					.send({})
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(200)
					.then(() => {
						expect(logWarnStub).to.have.been.calledWith(
							"Key 'network' must exist in PATCH body",
						);
					});

				expect(restartServiceSpy.callCount).to.equal(0);
			});
		});
	});

	describe('POST /v1/purge', () => {
		it('errors if no appId found in request body', async () => {
			await request
				.post('/v1/purge')
				.send({})
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(
					sampleResponses.V1.POST['/purge [400 Invalid/missing appId]']
						.statusCode,
				)
				.then((response) => {
					expect(response.text).to.equal(
						sampleResponses.V1.POST['/purge [400 Invalid/missing appId]'].text,
					);
				});
		});

		it('purges the /data directory with valid appId', async () => {
			const doPurgeStub: SinonStub = stub(
				deviceAPIActions,
				'doPurge',
			).resolves();

			await mockedDockerode.testWithData({ containers, images }, async () => {
				await request
					.post('/v1/purge')
					.send({ appId: 2 })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
					.expect(sampleResponses.V1.POST['/purge [200]'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V1.POST['/purge [200]'].body,
						);
					});
			});

			expect(doPurgeStub.callCount).to.equal(1);
			doPurgeStub.restore();
		});

		it('errors if appId is out of scope (application not available)', async () => {
			// Generate a new scoped key to call the endpoint, as mocked
			// appId = 2 services are all in the global scope and thus
			// resolve to true for any isScoped check
			const scopedKey = await deviceApi.generateScopedKey(
				2,
				containers[0].serviceName,
			);

			await request
				.post('/v1/purge')
				.send({ appId: 3 })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(sampleResponses.V1.POST['/purge [401 Out of scope]'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V1.POST['/purge [401 Out of scope]'].body,
					);
				});
		});
	});
});
