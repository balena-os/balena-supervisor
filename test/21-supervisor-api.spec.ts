import { expect } from 'chai';
import { spy, stub, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import * as apiBinder from '../src/api-binder';
import * as deviceState from '../src/device-state';
import Log from '../src/lib/supervisor-console';
import SupervisorAPI from '../src/supervisor-api';
import sampleResponses = require('./data/device-api-responses.json');
import mockedAPI = require('./lib/mocked-device-api');

import * as applicationManager from '../src/compose/application-manager';
import { InstancedAppState } from '../src/types/state';

import * as serviceManager from '../src/compose/service-manager';
import * as images from '../src/compose/images';

import * as apiKeys from '../src/lib/api-keys';
import * as db from '../src/db';
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

describe('SupervisorAPI', () => {
	let api: SupervisorAPI;
	let healthCheckStubs: SinonStub[];
	const request = supertest(`http://127.0.0.1:${mockedOptions.listenPort}`);

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
		await api.listen(mockedOptions.listenPort, mockedOptions.timeout);

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

	describe('API Key Scope', () => {
		it('should generate a key which is scoped for a single application', async () => {
			// single app scoped key...
			const appScopedKey = await apiKeys.generateScopedKey(1, 1);

			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect(200);
		});
		it('should generate a key which is scoped for multiple applications', async () => {
			// multi-app scoped key...
			const multiAppScopedKey = await apiKeys.generateScopedKey(1, 2, {
				scopes: [1, 2].map((appId) => {
					return { type: 'app', appId };
				}),
			});

			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${multiAppScopedKey}`)
				.expect(200);

			await request
				.get('/v2/applications/2/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${multiAppScopedKey}`)
				.expect(200);
		});
		it('should generate a key which is scoped for all applications', async () => {
			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);

			await request
				.get('/v2/applications/2/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});
		it('should have a cached lookup of the key scopes to save DB loading', async () => {
			const scopes = await apiKeys.getScopesForKey(apiKeys.cloudApiKey);

			const key = 'not-a-normal-key';
			await db.initialized;
			await db
				.models('apiSecret')
				.update({
					key,
				})
				.where({
					key: apiKeys.cloudApiKey,
				});

			// the key we had is now gone, but the cache should return values
			const cachedScopes = await apiKeys.getScopesForKey(apiKeys.cloudApiKey);
			expect(cachedScopes).to.deep.equal(scopes);

			// this should bust the cache...
			await apiKeys.generateCloudKey(true);

			// the key we changed should be gone now, and the new key should have the cloud scopes
			const missingScopes = await apiKeys.getScopesForKey(key);
			const freshScopes = await apiKeys.getScopesForKey(apiKeys.cloudApiKey);

			expect(missingScopes).to.be.null;
			expect(freshScopes).to.deep.equal(scopes);
		});
		it('should regenerate a key and invalidate the old one', async () => {
			// single app scoped key...
			const appScopedKey = await apiKeys.generateScopedKey(1, 1);

			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect(200);

			const newScopedKey = await apiKeys.refreshKey(appScopedKey);

			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect(401);

			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${newScopedKey}`)
				.expect(200);
		});
	});

	describe('/ping', () => {
		it('responds with OK (without auth)', async () => {
			await request.get('/ping').set('Accept', 'application/json').expect(200);
		});
		it('responds with OK (with auth)', async () => {
			await request
				.get('/ping')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});
	});

	describe('V1 endpoints', () => {
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

		before(() => {
			const appState = {
				[sampleResponses.V1.GET['/apps/2'].body.appId]: {
					...sampleResponses.V1.GET['/apps/2'].body,
					services: [
						{
							...sampleResponses.V1.GET['/apps/2'].body,
							serviceId: 1,
							serviceName: 'main',
							config: {},
						},
					],
				},
			};

			stub(applicationManager, 'getCurrentApps').resolves(
				(appState as unknown) as InstancedAppState,
			);
			stub(applicationManager, 'executeStep').resolves();
		});

		after(() => {
			(applicationManager.executeStep as SinonStub).restore();
			(applicationManager.getCurrentApps as SinonStub).restore();
		});

		// TODO: add tests for V1 endpoints
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
	});

	describe('V2 endpoints', () => {
		let serviceManagerMock: SinonStub;
		let imagesMock: SinonStub;

		before(async () => {
			serviceManagerMock = stub(serviceManager, 'getAll').resolves([]);
			imagesMock = stub(images, 'getStatus').resolves([]);
		});

		after(async () => {
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

	describe('State change logging', () => {
		before(() => {
			// Spy on functions we will be testing
			spy(Log, 'info');
			spy(Log, 'error');
		});

		beforeEach(async () => {
			// Start each case with API stopped
			try {
				await api.stop();
			} catch (e) {
				if (e.message !== 'Server is not running.') {
					throw e;
				}
			}
		});

		after(async () => {
			// @ts-ignore
			Log.info.restore();
			// @ts-ignore
			Log.error.restore();
			// Resume API for other test suites
			return api.listen(mockedOptions.listenPort, mockedOptions.timeout);
		});

		it('logs successful start', async () => {
			// Start API
			await api.listen(mockedOptions.listenPort, mockedOptions.timeout);
			// Check if success start was logged
			// @ts-ignore
			expect(Log.info.lastCall?.lastArg).to.equal(
				`Supervisor API successfully started on port ${mockedOptions.listenPort}`,
			);
		});

		it('logs shutdown', async () => {
			// Start API
			await api.listen(mockedOptions.listenPort, mockedOptions.timeout);
			// Stop API
			await api.stop();
			// Check if stopped with info was logged
			// @ts-ignore
			expect(Log.info.lastCall?.lastArg).to.equal('Stopped Supervisor API');
		});

		it('logs errored shutdown', async () => {
			// Start API
			await api.listen(mockedOptions.listenPort, mockedOptions.timeout);
			// Stop API with error
			await api.stop({ errored: true });
			// Check if stopped with error was logged
			// @ts-ignore
			expect(Log.error.lastCall?.lastArg).to.equal('Stopped Supervisor API');
		});
	});
});
