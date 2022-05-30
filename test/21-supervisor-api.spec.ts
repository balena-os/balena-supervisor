import { expect } from 'chai';
import { spy } from 'sinon';
import * as supertest from 'supertest';

import mockedAPI = require('./lib/mocked-device-api');
import * as apiBinder from '../src/api-binder';
import * as deviceState from '../src/device-state';
import Log from '../src/lib/supervisor-console';
import SupervisorAPI from '../src/device-api';
import { apiKeys } from '../src/device-api';
import * as db from '../src/db';

const mockedOptions = {
	listenPort: 54321,
	timeout: 30000,
};

describe('SupervisorAPI', () => {
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

	describe('API Key Scope', () => {
		it('should generate a key which is scoped for a single application', async () => {
			// single app scoped key...
			const appScopedKey = await apiKeys.generateScopedKey(1, 'main');

			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect(200);
		});
		it('should generate a key which is scoped for multiple applications', async () => {
			// multi-app scoped key...
			const multiAppScopedKey = await apiKeys.generateScopedKey(1, 'other', {
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
			const appScopedKey = await apiKeys.generateScopedKey(1, 'main');

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

	describe('Authentication', () => {
		const INVALID_SECRET = 'bad_api_secret';

		it('finds no apiKey and rejects', async () => {
			return request.post('/v1/blink').expect(401);
		});

		it('finds apiKey from query', async () => {
			return request
				.post(`/v1/blink?apikey=${apiKeys.cloudApiKey}`)
				.expect(200);
		});

		it('finds apiKey from Authorization header (ApiKey scheme)', async () => {
			return request
				.post('/v1/blink')
				.set('Authorization', `ApiKey ${apiKeys.cloudApiKey}`)
				.expect(200);
		});

		it('finds apiKey from Authorization header (Bearer scheme)', async () => {
			return request
				.post('/v1/blink')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});

		it('finds apiKey from Authorization header (case insensitive)', async () => {
			const randomCases = [
				'Bearer',
				'bearer',
				'BEARER',
				'BeAReR',
				'ApiKey',
				'apikey',
				'APIKEY',
				'ApIKeY',
			];
			for (const scheme of randomCases) {
				return request
					.post('/v1/blink')
					.set('Authorization', `${scheme} ${apiKeys.cloudApiKey}`)
					.expect(200);
			}
		});

		it('rejects invalid apiKey from query', async () => {
			return request.post(`/v1/blink?apikey=${INVALID_SECRET}`).expect(401);
		});

		it('rejects invalid apiKey from Authorization header (ApiKey scheme)', async () => {
			return request
				.post('/v1/blink')
				.set('Authorization', `ApiKey ${INVALID_SECRET}`)
				.expect(401);
		});

		it('rejects invalid apiKey from Authorization header (Bearer scheme)', async () => {
			return request
				.post('/v1/blink')
				.set('Authorization', `Bearer ${INVALID_SECRET}`)
				.expect(401);
		});
	});
});
