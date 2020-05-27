import * as supertest from 'supertest';

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
		return request
			.post('/v1/blink')
			.set('Authorization', `ApiKey ${cloudKey}`)
			.expect(200);
	});

	it('finds apiKey from Authorization header (Bearer scheme)', async () => {
		return request
			.post('/v1/blink')
			.set('Authorization', `Bearer ${cloudKey}`)
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
				.set('Authorization', `${scheme} ${cloudKey}`)
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

	describe('Api secret regeneration', () => {
		it(`should regenerate all keys when a secret has 'apps' scope`, () => {
			throw new Error('Do this');
		});
		it(`should regenerate keys for a specific app when a secret has 'app' scope`, () => {
			throw new Error('Do this');
		});
	});
});
