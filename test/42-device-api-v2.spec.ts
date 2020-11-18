import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import sampleResponses = require('./data/device-api-responses.json');
import mockedAPI = require('./lib/mocked-device-api');
import * as apiBinder from '../src/api-binder';
import * as deviceState from '../src/device-state';
import SupervisorAPI from '../src/supervisor-api';
import * as serviceManager from '../src/compose/service-manager';
import * as images from '../src/compose/images';
import * as apiKeys from '../src/lib/api-keys';
import * as config from '../src/config';
import { Service } from '../src/compose/service';
import { Image } from '../src/compose/images';

const mockedOptions = {
	listenPort: 54321,
	timeout: 30000,
};

const mockService = (overrides?: Partial<Service>) => {
	return {
		...{
			appId: 1658654,
			status: 'Running',
			serviceName: 'main',
			imageId: 2885946,
			serviceId: 640681,
			containerId:
				'f93d386599d1b36e71272d46ad69770cff333842db04e2e4c64dda7b54da07c6',
			createdAt: '2020-11-13T20:29:44.143Z',
		},
		...overrides,
	} as Service;
};

const mockImage = (overrides?: Partial<Image>) => {
	return {
		...{
			name:
				'registry2.balena-cloud.com/v2/e2bf6410ffc30850e96f5071cdd1dca8@sha256:e2e87a8139b8fc14510095b210ad652d7d5badcc64fdc686cbf749d399fba15e',
			appId: 1658654,
			serviceName: 'main',
			imageId: 2885946,
			dockerImageId:
				'sha256:4502983d72e2c72bc292effad1b15b49576da3801356f47fd275ba274d409c1a',
			status: 'Downloaded',
			downloadProgress: null,
		},
		...overrides,
	} as Image;
};

describe('SupervisorAPI [V2 Endpoints]', () => {
	let serviceManagerMock: SinonStub;
	let imagesMock: SinonStub;
	let api: SupervisorAPI;
	const request = supertest(`http://127.0.0.1:${mockedOptions.listenPort}`);

	before(async () => {
		await apiBinder.initialized;
		await deviceState.initialized;

		// The mockedAPI contains stubs that might create unexpected results
		// See the module to know what has been stubbed
		api = await mockedAPI.create();

		// Start test API
		await api.listen(mockedOptions.listenPort, mockedOptions.timeout);

		// Create a scoped key
		await apiKeys.initialized;
		await apiKeys.generateCloudKey();
		serviceManagerMock = stub(serviceManager, 'getAll').resolves([]);
		imagesMock = stub(images, 'getStatus').resolves([]);
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e) {
			if (e.message !== 'Server is not running.') {
				throw e;
			}
		}
		// Remove any test data generated
		await mockedAPI.cleanUp();
		serviceManagerMock.restore();
		imagesMock.restore();
	});

	describe('GET /v2/device/vpn', () => {
		it('returns information about VPN connection', async () => {
			await request
				.get('/v2/device/vpn')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
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
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(sampleResponses.V2.GET['/applications/9000/state'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/applications/9000/state'].body,
					);
				});
		});

		describe('Scoped API Keys', () => {
			it('returns 409 because app is out of scope of the key', async () => {
				const apiKey = await apiKeys.generateScopedKey(3, 1);
				await request
					.get('/v2/applications/2/state')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${apiKey}`)
					.expect(409);
			});
		});
	});

	describe('GET /v2/state/status', () => {
		it('should return scoped application', async () => {
			// Create scoped key for application
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 640681);
			// Setup device conditions
			serviceManagerMock.resolves([mockService({ appId: 1658654 })]);
			imagesMock.resolves([mockImage({ appId: 1658654 })]);
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
			const appScopedKey = await apiKeys.generateScopedKey(1, 1);
			// Setup device conditions
			serviceManagerMock.resolves([mockService({ appId: 1658654 })]);
			imagesMock.resolves([mockImage({ appId: 1658654 })]);
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
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 1658654);
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
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 640681);
			// Setup device conditions
			serviceManagerMock.resolves([
				mockService({ appId: 1658654 }),
				mockService({ appId: 222222 }),
			]);
			imagesMock.resolves([
				mockImage({ appId: 1658654 }),
				mockImage({ appId: 222222 }),
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
				mockService({ appId: 1658654 }),
				mockService({ appId: 222222 }),
			]);
			imagesMock.resolves([
				mockImage({ appId: 1658654 }),
				mockImage({ appId: 222222 }),
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
			// Deactivate localmode
			await config.set({ localMode: false });
		});
	});

	// TODO: add tests for rest of V2 endpoints
});
