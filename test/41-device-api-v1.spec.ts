import * as _ from 'lodash';
import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import * as appMock from './lib/application-state-mock';
import * as mockedDockerode from './lib/mocked-dockerode';
import mockedAPI = require('./lib/mocked-device-api');
import sampleResponses = require('./data/device-api-responses.json');
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
	});

	beforeEach(() => {
		// Sane defaults
		appMock.mockSupervisorNetwork(true);
		appMock.mockManagers([], [], []);
		appMock.mockImages([], false, []);
	});

	afterEach(() => {
		appMock.unmockAll();
		// Clear Dockerode actions recorded for each test
		mockedDockerode.resetHistory();
	});

	describe('POST /v1/restart', () => {
		it('restarts application', async () => {
			const ID_TO_RESTART = 2;
			// single app scoped key...
			const appScopedKey = await apiKeys.generateScopedKey(
				ID_TO_RESTART,
				640681,
			);
			const service = mockedAPI.mockService({
				appId: ID_TO_RESTART,
				serviceId: 640681,
			});
			const image = mockedAPI.mockImage({
				appId: ID_TO_RESTART,
				serviceId: 640681,
			});
			const images = [image];
			const containers = [service];
			// Setup device conditions
			appMock.mockManagers([service], [], []);
			appMock.mockImages([], false, images);
			// Perform the test with our specially crafted data
			await mockedDockerode.testWithData({ containers, images }, async () => {
				// Perform test
				await request
					.post('/v1/restart')
					.send({ appId: ID_TO_RESTART })
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${appScopedKey}`)
					.expect(sampleResponses.V1.POST['/restart'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V1.POST['/restart'].body,
						);
						expect(response.text).to.deep.equal(
							sampleResponses.V1.POST['/restart'].text,
						);
					});
				// Check that mockedDockerode contains 1 stop and start action
				const removeSteps = _(mockedDockerode.actions)
					.pickBy({ name: 'stop' })
					.map()
					.value();
				expect(removeSteps).to.have.lengthOf(1);
				const startSteps = _(mockedDockerode.actions)
					.pickBy({ name: 'start' })
					.map()
					.value();
				expect(startSteps).to.have.lengthOf(1);
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
		it('returns information about a specific application', async () => {
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
		it('stops a SPECIFIC application and returns a containerId', async () => {
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
