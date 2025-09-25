import { expect } from 'chai';
import type { SinonStub, SinonSpy } from 'sinon';
import { stub, spy } from 'sinon';
import supertest from 'supertest';

import sampleResponses from '~/test-data/device-api-responses.json';
import mockedAPI from '~/test-lib/mocked-device-api';
import * as apiBinder from '~/src/api-binder';
import * as deviceState from '~/src/device-state';
import type SupervisorAPI from '~/src/device-api';
import * as apiKeys from '~/lib/api-keys';
import * as serviceManager from '~/src/compose/service-manager';
import * as images from '~/src/compose/images';
import * as config from '~/src/config';
import * as mockedDockerode from '~/test-lib/mocked-dockerode';
import * as applicationManager from '~/src/compose/application-manager';
import * as logger from '~/src/logging';

describe('SupervisorAPI [V2 Endpoints]', () => {
	let serviceManagerMock: SinonStub;
	let imagesMock: SinonStub;
	let applicationManagerSpy: SinonSpy;
	let api: SupervisorAPI;
	const request = supertest(
		`http://127.0.0.1:${mockedAPI.mockedOptions.listenPort}`,
	);

	let loggerStub: SinonStub;

	before(async () => {
		await apiBinder.initialized();
		await deviceState.initialized();

		// The mockedAPI contains stubs that might create unexpected results
		// See the module to know what has been stubbed
		api = await mockedAPI.create();

		// Start test API
		await api.listen(
			mockedAPI.mockedOptions.listenPort,
			mockedAPI.mockedOptions.timeout,
		);

		serviceManagerMock = stub(serviceManager, 'getAll').resolves([]);
		imagesMock = stub(images, 'getState').resolves([]);

		// We want to check the actual step that was triggered
		applicationManagerSpy = spy(applicationManager, 'executeStep');

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
		// Remove any test data generated
		await mockedAPI.cleanUp();
		serviceManagerMock.restore();
		imagesMock.restore();
		applicationManagerSpy.restore();
		loggerStub.restore();
	});

	afterEach(() => {
		mockedDockerode.resetHistory();
		applicationManagerSpy.resetHistory();
	});

	describe('GET /v2/device/vpn', () => {
		it('returns information about VPN connection', async () => {
			await request
				.get('/v2/device/vpn')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect('Content-Type', /json/)
				.expect(sampleResponses.V2.GET['/device/vpn'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/device/vpn'].body,
					);
				});
		});
	});

	describe('GET /v2/applications/:appId/state', () => {
		it('returns information about a SPECIFIC application', async () => {
			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(sampleResponses.V2.GET['/applications/1/state'].statusCode)
				.expect('Content-Type', /json/)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/applications/1/state'].body,
					);
				});
		});

		it('returns 400 for invalid appId', async () => {
			await request
				.get('/v2/applications/123invalid/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/applications/123invalid/state'].statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/applications/123invalid/state'].body,
					);
				});
		});

		it('returns 409 because app does not exist', async () => {
			await request
				.get('/v2/applications/9000/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(sampleResponses.V2.GET['/applications/9000/state'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/applications/9000/state'].body,
					);
				});
		});

		describe('Scoped API Keys', () => {
			it('returns 409 because app is out of scope of the key', async () => {
				const apiKey = await apiKeys.generateScopedKey(3, 'main');
				await request
					.get('/v2/applications/2/state')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${apiKey}`)
					.expect(409);
			});
		});
	});

	describe('GET /v2/state/status', () => {
		before(() => {
			// Stub isApplyInProgress is no other tests can impact the response data
			stub(deviceState, 'isApplyInProgress').returns(false);
		});

		after(() => {
			(deviceState.isApplyInProgress as SinonStub).restore();
		});

		it('should return scoped application', async () => {
			// Create scoped key for application
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 'main');
			// Setup device conditions
			serviceManagerMock.resolves([mockedAPI.mockService({ appId: 1658654 })]);
			imagesMock.resolves([mockedAPI.mockImage({ appId: 1658654 })]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=single_application']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=single_application']
							.body,
					);
				});
		});

		it('should return no application info due to lack of scope', async () => {
			// Create scoped key for wrong application
			const appScopedKey = await apiKeys.generateScopedKey(1, 'main');
			// Setup device conditions
			serviceManagerMock.resolves([mockedAPI.mockService({ appId: 1658654 })]);
			imagesMock.resolves([mockedAPI.mockImage({ appId: 1658654 })]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=no_applications']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=no_applications'].body,
					);
				});
		});

		it('should return success when device has no applications', async () => {
			// Create scoped key for any application
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 'main');
			// Setup device conditions
			serviceManagerMock.resolves([]);
			imagesMock.resolves([]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=no_applications']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=no_applications'].body,
					);
				});
		});

		it('should only return 1 application when N > 1 applications on device', async () => {
			// Create scoped key for application
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 'main');
			// Setup device conditions
			serviceManagerMock.resolves([
				mockedAPI.mockService({ appId: 1658654 }),
				mockedAPI.mockService({ appId: 222222 }),
			]);
			imagesMock.resolves([
				mockedAPI.mockImage({ appId: 1658654 }),
				mockedAPI.mockImage({ appId: 222222 }),
			]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=single_application']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=single_application']
							.body,
					);
				});
		});

		it('should only return 1 application when in LOCAL MODE (no auth)', async () => {
			// Activate localmode
			await config.set({ localMode: true });
			// Setup device conditions
			serviceManagerMock.resolves([
				mockedAPI.mockService({ appId: 1658654 }),
				mockedAPI.mockService({ appId: 222222 }),
			]);
			imagesMock.resolves([
				mockedAPI.mockImage({ appId: 1658654 }),
				mockedAPI.mockImage({ appId: 222222 }),
			]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=single_application']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=single_application']
							.body,
					);
				});
		});
	});

	// TODO: add tests for rest of V2 endpoints
});
