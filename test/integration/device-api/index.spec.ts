import type * as express from 'express';
import request from 'supertest';

import * as deviceApi from '~/src/device-api';

describe('device-api/index', () => {
	let api: express.Application;

	before(async () => {
		api = new deviceApi.SupervisorAPI({
			routers: [],
			healthchecks: [],
			// @ts-expect-error extract private variable for testing
		}).api;
		// Express app set in SupervisorAPI is private here
		// but we need to access it for supertest
	});

	describe('/ping', () => {
		it('responds with 200 regardless of auth', async () => {
			await request(api).get('/ping').expect(200);

			await request(api)
				.get('/ping')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});
	});
});
