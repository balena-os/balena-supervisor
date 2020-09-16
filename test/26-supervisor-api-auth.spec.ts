import * as supertest from 'supertest';

import SupervisorAPI from '../src/supervisor-api';
import mockedAPI = require('./lib/mocked-device-api');
import { cloudApiKey } from '../src/lib/api-keys';

const mockedOptions = {
	listenPort: 12345,
	timeout: 30000,
};

const INVALID_SECRET = 'bad_api_secret';

describe('SupervisorAPI authentication', () => {
	let api: SupervisorAPI;
	const request = supertest(`http://127.0.0.1:${mockedOptions.listenPort}`);

	before(async () => {
		// Create test API
		api = await mockedAPI.create();
		// Start test API
		return api.listen(mockedOptions.listenPort, mockedOptions.timeout);
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
		return request.post(`/v1/blink?apikey=${cloudApiKey}`).expect(200);
	});

	it('finds apiKey from Authorization header (ApiKey scheme)', async () => {
		return request
			.post('/v1/blink')
			.set('Authorization', `ApiKey ${cloudApiKey}`)
			.expect(200);
	});

	it('finds apiKey from Authorization header (Bearer scheme)', async () => {
		return request
			.post('/v1/blink')
			.set('Authorization', `Bearer ${cloudApiKey}`)
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
				.set('Authorization', `${scheme} ${cloudApiKey}`)
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
