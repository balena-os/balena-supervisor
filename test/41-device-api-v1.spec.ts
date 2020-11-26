import * as _ from 'lodash';
import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import * as appMock from './lib/application-state-mock';
import * as mockedDockerode from './lib/mocked-dockerode';
import mockedAPI = require('./lib/mocked-device-api');
import sampleResponses = require('./data/device-api-responses.json');
import * as logger from '../src/logger';
import SupervisorAPI from '../src/supervisor-api';
import * as apiBinder from '../src/api-binder';
import * as deviceState from '../src/device-state';
import * as apiKeys from '../src/lib/api-keys';

describe('SupervisorAPI [V1 Endpoints]', () => {
	let api: SupervisorAPI;
	let healthCheckStubs: SinonStub[];
	const request = supertest(
		`http://127.0.0.1:${mockedAPI.mockedOptions.listenPort}`,
	);
	const containers = [
		mockedAPI.mockService({
			appId: 2,
			serviceId: 640681,
		}),
		mockedAPI.mockService({
			appId: 2,
			serviceId: 640682,
		}),
		mockedAPI.mockService({
			appId: 2,
			serviceId: 640683,
		}),
	];
	const images = [
		mockedAPI.mockImage({
			appId: 2,
			serviceId: 640681,
		}),
		mockedAPI.mockImage({
			appId: 2,
			serviceId: 640682,
		}),
		mockedAPI.mockImage({
			appId: 2,
			serviceId: 640683,
		}),
	];

	beforeEach(() => {
		// Mock a 3 container release
		appMock.mockManagers(containers, [], []);
		appMock.mockImages([], false, images);
		appMock.mockSupervisorNetwork(true);
	});

	afterEach(() => {
		// Clear Dockerode actions recorded for each test
		mockedDockerode.resetHistory();
	});

	before(async () => {
		await apiBinder.initialized;
		await deviceState.initialized;

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

		// Create a scoped key
		await apiKeys.initialized;
		await apiKeys.generateCloudKey();
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
	});

	describe('POST /v1/restart', () => {
		let loggerStub: SinonStub;

		before(async () => {
			loggerStub = stub(logger, 'attach');
			loggerStub.resolves();
		});

		after(() => {
			loggerStub.restore();
		});

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
			// Make one of the healthChecks fail
			healthCheckStubs[0].resolves(false);
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

	// TODO: add tests for V1 endpoints
});
