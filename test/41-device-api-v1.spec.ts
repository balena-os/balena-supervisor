import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import { expect } from 'chai';
import {
	stub,
	spy,
	useFakeTimers,
	SinonStub,
	SinonSpy,
	SinonFakeTimers,
} from 'sinon';
import * as supertest from 'supertest';

import * as appMock from './lib/application-state-mock';
import * as mockedDockerode from './lib/mocked-dockerode';
import mockedAPI = require('./lib/mocked-device-api');
import sampleResponses = require('./data/device-api-responses.json');
import * as config from '../src/config';
import * as logger from '../src/logger';
import SupervisorAPI from '../src/supervisor-api';
import * as apiBinder from '../src/api-binder';
import * as deviceState from '../src/device-state';
import * as apiKeys from '../src/lib/api-keys';
import * as dbus from '../src//lib/dbus';
import * as updateLock from '../src/lib/update-lock';
import * as TargetState from '../src/device-state/target-state';
import * as targetStateCache from '../src/device-state/target-state-cache';
import blink = require('../src/lib/blink');

import { UpdatesLockedError } from '../src/lib/errors';

describe('SupervisorAPI [V1 Endpoints]', () => {
	let api: SupervisorAPI;
	let healthCheckStubs: SinonStub[];
	let targetStateCacheMock: SinonStub;
	const request = supertest(
		`http://127.0.0.1:${mockedAPI.mockedOptions.listenPort}`,
	);
	const services = [
		{ appId: 2, serviceId: 640681, serviceName: 'one' },
		{ appId: 2, serviceId: 640682, serviceName: 'two' },
		{ appId: 2, serviceId: 640683, serviceName: 'three' },
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
			commit: 'abcdef2',
			name: 'test-app2',
			source: 'https://api.balena-cloud.com',
			releaseId: 1232,
			services: JSON.stringify(services),
			networks: '{}',
			volumes: '{}',
		});
	});

	afterEach(() => {
		// Clear Dockerode actions recorded for each test
		mockedDockerode.resetHistory();
	});

	before(async () => {
		await apiBinder.initialized;
		await deviceState.initialized;
		await targetStateCache.initialized;

		// Stub health checks so we can modify them whenever needed
		healthCheckStubs = [
			stub(apiBinder, 'healthcheck'),
			stub(deviceState, 'healthcheck'),
		];

		// The mockedAPI contains stubs that might create unexpected results
		// See the module to know what has been stubbed
		api = await mockedAPI.create();

		// Start test API
		await api.listen(
			mockedAPI.mockedOptions.listenPort,
			mockedAPI.mockedOptions.timeout,
		);

		// Mock target state cache
		targetStateCacheMock = stub(targetStateCache, 'getTargetApp');

		// Create a scoped key
		await apiKeys.initialized;
		await apiKeys.generateCloudKey();

		// Stub logs for all API methods
		loggerStub = stub(logger, 'attach');
		loggerStub.resolves();
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e) {
			if (e.message !== 'Server is not running.') {
				throw e;
			}
		}
		// Restore healthcheck stubs
		healthCheckStubs.forEach((hc) => hc.restore);
		// Remove any test data generated
		await mockedAPI.cleanUp();
		appMock.unmockAll();
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
					.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
			// Every test case in this suite has a 3 service release mocked so just make the request
			await request
				.get('/v1/apps/2')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
			// Make request
			await request
				.get('/v1/apps/2')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(sampleResponses.V1.GET['/apps/2'].statusCode)
				.expect('Content-Type', /json/)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V1.GET['/apps/2'].body,
					);
				});
		});
	});

	describe('POST /v1/apps/:appId/stop', () => {
		it('does not allow stopping an application when there is more than 1 container', async () => {
			// Every test case in this suite has a 3 service release mocked so just make the request
			await request
				.post('/v1/apps/2/stop')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(
					sampleResponses.V1.GET['/apps/2/stop [Multiple containers running]']
						.statusCode,
				);
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
						.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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

	describe('POST /v1/apps/:appId/start', () => {
		it('does not allow starting an application when there is more than 1 container', async () => {
			// Every test case in this suite has a 3 service release mocked so just make the request
			await request
				.post('/v1/apps/2/start')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(400);
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
				volumes: '{}',
				networks: '{}',
			});

			// Perform the test with our mocked release
			await mockedDockerode.testWithData(
				{ containers: [container], images: [image] },
				async () => {
					await request
						.post('/v1/apps/2/start')
						.set('Accept', 'application/json')
						.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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

			const response = await request
				.post('/v1/reboot')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(202);

			expect(response.body).to.have.property('Data').that.is.not.empty;
			expect(rebootMock).to.have.been.calledOnce;
		});

		it('should return 423 and reject the reboot if no locks are set', async () => {
			stub(updateLock, 'lock').callsFake((__, opts, fn) => {
				if (opts.force) {
					return Bluebird.resolve(fn());
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

			const response = await request
				.post('/v1/reboot')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(423);

			expect(updateLock.lock).to.be.calledOnce;
			expect(response.body).to.have.property('Error').that.is.not.empty;
			expect(rebootMock).to.not.have.been.called;

			(updateLock.lock as SinonStub).restore();
		});

		it('should return 202 and reboot if force is set to true', async () => {
			stub(updateLock, 'lock').callsFake((__, opts, fn) => {
				if (opts.force) {
					return Bluebird.resolve(fn());
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

			const response = await request
				.post('/v1/reboot')
				.send({ force: true })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(202);

			expect(updateLock.lock).to.be.calledOnce;
			expect(response.body).to.have.property('Data').that.is.not.empty;
			expect(rebootMock).to.have.been.calledOnce;

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

			const response = await request
				.post('/v1/shutdown')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(202);

			expect(response.body).to.have.property('Data').that.is.not.empty;
			expect(shutdownMock).to.have.been.calledOnce;

			shutdownMock.resetHistory();
		});

		it('should return 423 and reject the reboot if no locks are set', async () => {
			stub(updateLock, 'lock').callsFake((__, opts, fn) => {
				if (opts.force) {
					return Bluebird.resolve(fn());
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

			const response = await request
				.post('/v1/shutdown')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(423);

			expect(updateLock.lock).to.be.calledOnce;
			expect(response.body).to.have.property('Error').that.is.not.empty;
			expect(shutdownMock).to.not.have.been.called;

			(updateLock.lock as SinonStub).restore();
		});

		it('should return 202 and shutdown if force is set to true', async () => {
			stub(updateLock, 'lock').callsFake((__, opts, fn) => {
				if (opts.force) {
					return Bluebird.resolve(fn());
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

			const response = await request
				.post('/v1/shutdown')
				.send({ force: true })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(202);

			expect(updateLock.lock).to.be.calledOnce;
			expect(response.body).to.have.property('Data').that.is.not.empty;
			expect(shutdownMock).to.have.been.calledOnce;

			(updateLock.lock as SinonStub).restore();
		});
	});

	describe('POST /v1/update', () => {
		let configStub: SinonStub;
		let targetUpdateSpy: SinonSpy;

		before(() => {
			configStub = stub(config, 'get');
			targetUpdateSpy = spy(TargetState, 'update');
		});

		afterEach(() => {
			targetUpdateSpy.resetHistory();
		});

		after(() => {
			configStub.restore();
			targetUpdateSpy.restore();
		});

		it('returns 204 with no parameters', async () => {
			// Stub response for getting instantUpdates
			configStub.resolves(true);
			// Make request
			await request
				.post('/v1/update')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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

	// TODO: add tests for V1 endpoints
});
