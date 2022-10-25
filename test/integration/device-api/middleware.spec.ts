import * as express from 'express';
import * as request from 'supertest';

import * as config from '~/src/config';
import * as testDb from '~/src/db';
import * as deviceApi from '~/src/device-api';
import * as middleware from '~/src/device-api/middleware';

describe('device-api/middleware', () => {
	let app: express.Application;

	before(async () => {
		await config.initialized();
	});

	describe('auth', () => {
		const INVALID_KEY = 'bad_api_secret';

		before(() => {
			app = express();
			app.use(middleware.auth);
			app.get('/', (_req, res) => res.sendStatus(200));
		});

		afterEach(async () => {
			// Delete all API keys between calls to prevent leaking tests
			await testDb.models('apiSecret').del();
			// Reset local mode to default
			await config.set({ localMode: false });
		});

		it('responds with 401 if no API key', async () => {
			await request(app).get('/').expect(401);
		});

		it('validates API key from request query', async () => {
			await request(app)
				.get(`/?apikey=${await deviceApi.getGlobalApiKey()}`)
				.expect(200);

			await request(app).get(`/?apikey=${INVALID_KEY}`).expect(401);

			// Should not accept case insensitive scheme
			const cases = ['ApiKey', 'apiKey', 'APIKEY', 'ApIKeY'];
			for (const query of cases) {
				await request(app)
					.get(`/?${query}=${await deviceApi.getGlobalApiKey()}`)
					.expect(401);
			}
		});

		it('validates API key from Authorization header with ApiKey scheme', async () => {
			// Should accept case insensitive scheme
			const cases = ['ApiKey', 'apikey', 'APIKEY', 'ApIKeY'];
			for (const scheme of cases) {
				await request(app)
					.get('/')
					.set(
						'Authorization',
						`${scheme} ${await deviceApi.getGlobalApiKey()}`,
					)
					.expect(200);

				await request(app)
					.get('/')
					.set('Authorization', `${scheme} ${INVALID_KEY}`)
					.expect(401);
			}
		});

		it('finds API key from Authorization header with Bearer scheme', async () => {
			// Should accept case insensitive scheme
			const cases: string[] = ['Bearer', 'bearer', 'BEARER', 'BeAReR'];
			for (const scheme of cases) {
				await request(app)
					.get('/')
					.set(
						'Authorization',
						`${scheme} ${await deviceApi.getGlobalApiKey()}`,
					)
					.expect(200);

				await request(app)
					.get('/')
					.set('Authorization', `${scheme} ${INVALID_KEY}`)
					.expect(401);
			}
		});

		it("doesn't validate auth in local mode", async () => {
			const testRequest = async (code: number) =>
				await request(app)
					.get('/')
					.set('Authorization', `Bearer ${INVALID_KEY}`)
					.expect(code);

			await testRequest(401);
			await config.set({ localMode: true });
			await testRequest(200);
		});
	});
});
