import * as supertest from 'supertest';
import { expect } from 'chai';

import * as apiSecrets from '../src/lib/api-secrets';
import SupervisorAPI from '../src/supervisor-api';
import mockedAPI = require('./lib/mocked-device-api');

const mockedOptions = {
	listenPort: 12345,
	timeout: 30000,
};

const INVALID_SECRET = 'bad_api_secret';
const ALLOWED_INTERFACES = ['lo']; // Only need loopback since this is for testing

describe('SupervisorAPI authentication', () => {
	let api: SupervisorAPI;
	let cloudKey: string;
	const request = supertest(`http://127.0.0.1:${mockedOptions.listenPort}`);

	const postWithKey = (endpoint: string, key: string): supertest.Test => {
		return request.post(endpoint).set('Authorization', `Bearer ${key}`);
	};

	before(async () => {
		// Create test API
		api = await mockedAPI.create();
		cloudKey = await apiSecrets.getCloudApiSecret();
		// Start test API
		return api.listen(
			ALLOWED_INTERFACES,
			mockedOptions.listenPort,
			mockedOptions.timeout,
		);
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

	it('finds no apiKey and rejects', async () => {
		return request.post('/v1/blink').expect(401);
	});

	it('finds apiKey from query', async () => {
		return request.post(`/v1/blink?apikey=${cloudKey}`).expect(200);
	});

	it('finds apiKey from Authorization header (ApiKey scheme)', async () => {
		return postWithKey('/v1/blink', cloudKey).expect(200);
	});

	it('finds apiKey from Authorization header (Bearer scheme)', async () => {
		return postWithKey('/v1/blink', cloudKey);
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
			await request
				.post('/v1/blink')
				.set('Authorization', `${scheme} ${cloudKey}`)
				.expect(200);
		}
	});

	it('rejects invalid apiKey from query', async () => {
		return request.post(`/v1/blink?apikey=${INVALID_SECRET}`).expect(401);
	});

	it('rejects invalid apiKey from Authorization header (ApiKey scheme)', async () => {
		return postWithKey('/v1/blink', INVALID_SECRET).expect(401);
	});

	it('rejects invalid apiKey from Authorization header (Bearer scheme)', async () => {
		return postWithKey('/v1/blink', INVALID_SECRET).expect(401);
	});

	describe('Api secret regeneration', () => {
		const appIds = [1, 2, 3, 4];
		const serviceIds = [5, 6, 7, 8];
		const keys: {
			[appId: number]: {
				[serviceId: number]: string;
			};
		} = {};

		const getNewKeys = async () => {
			// Preseed some apikeys for different apps
			for (const appId of appIds) {
				const svcKeys: typeof keys[0] = {};
				for (const serviceId of serviceIds) {
					svcKeys[serviceId] = (
						await apiSecrets.getApiSecretForService(appId, serviceId, [
							{ type: 'app', appId },
						])
					).key;
				}
				keys[appId] = svcKeys;
			}
		};

		beforeEach(getNewKeys);

		it(`should regenerate all keys when a secret has 'all-apps' scope`, async () => {
			const data = await postWithKey('/v1/regenerate-api-key', cloudKey).expect(
				200,
			);

			// Ensure we get a key back, which is different to the cloudKey
			expect(data.text).to.not.equal(cloudKey);

			// Make sure the cloudKey no longer works
			await postWithKey('/v1/blink', cloudKey).expect(401);

			// And that the new one does work
			await postWithKey('/v1/blink', data.text).expect(200);

			// And test that all keys are now different
			for (const appId of appIds) {
				for (const serviceId of serviceIds) {
					await postWithKey('/v1/blink', keys[appId][serviceId]).expect(401);
				}
			}

			cloudKey = data.text;
		});

		it(`should regenerate keys for a specific app when a secret has 'app' scope`, async () => {
			for (const appId of appIds) {
				const keyToUse = keys[appId][serviceIds[0]];
				const data = await postWithKey(
					'/v1/regenerate-api-key',
					keyToUse,
				).expect(200);
				expect(data.text).to.not.equal(keyToUse);

				for (const appId2 of appIds) {
					for (const serviceId of serviceIds) {
						if (appId2 === appId) {
							// These keys shouldn't work now
							await postWithKey('/v1/blink', keys[appId2][serviceId]).expect(
								401,
							);
						} else {
							// These keys should work
							await postWithKey('/v1/blink', keys[appId2][serviceId]).expect(
								200,
							);
						}
					}
				}

				// Now refresh the keys, so we can do this all again
				await getNewKeys();
			}
		});

		it('should generate a new key when a different scope has been requested', async () => {
			const { key: newKey } = await apiSecrets.getApiSecretForService(
				appIds[0],
				serviceIds[0],
				[{ type: 'all-apps' }],
			);
			const oldKey = keys[appIds[0]][serviceIds[0]];

			// Make sure the old key doesn't work
			await postWithKey('/v1/blink', oldKey).expect(401);
			// And that the new key does
			await postWithKey('/v1/blink', newKey).expect(200);
		});
	});
});
