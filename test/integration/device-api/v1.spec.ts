import { expect } from 'chai';
import * as express from 'express';
import { SinonStub, stub } from 'sinon';
import * as request from 'supertest';

import * as config from '~/src/config';
import * as deviceApi from '~/src/device-api';
import * as actions from '~/src/device-api/actions';
import * as v1 from '~/src/device-api/v1';

describe('device-api/v1', () => {
	let api: express.Application;

	before(async () => {
		await config.initialized();

		// `api` is a private property on SupervisorAPI but
		// passing it directly to supertest is easier than
		// setting up an API listen port & timeout
		api = new deviceApi.SupervisorAPI({
			routers: [v1.router],
			healthchecks: [],
			// @ts-expect-error
		}).api;
	});

	describe('GET /v1/healthy', () => {
		after(() => {
			api = new deviceApi.SupervisorAPI({
				routers: [v1.router],
				healthchecks: [],
				// @ts-expect-error
			}).api;
		});

		it('responds with 200 because all healthchecks pass', async () => {
			api = new deviceApi.SupervisorAPI({
				routers: [v1.router],
				healthchecks: [stub().resolves(true), stub().resolves(true)],
				// @ts-expect-error
			}).api;
			await request(api).get('/v1/healthy').expect(200);
		});

		it('responds with 500 because some healthchecks did not pass', async () => {
			api = new deviceApi.SupervisorAPI({
				routers: [v1.router],
				healthchecks: [stub().resolves(false), stub().resolves(true)],
				// @ts-expect-error
			}).api;
			await request(api).get('/v1/healthy').expect(500);
		});
	});

	describe('POST /v1/blink', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		before(() => stub(actions, 'identify'));
		after(() => (actions.identify as SinonStub).restore());

		it('responds with 200', async () => {
			await request(api)
				.post('/v1/blink')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});
	});

	describe('POST /v1/regenerate-api-key', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		beforeEach(() => stub(actions, 'regenerateKey'));
		afterEach(() => (actions.regenerateKey as SinonStub).restore());

		it('responds with 200 and valid new API key', async () => {
			const oldKey = await deviceApi.getGlobalApiKey();
			const newKey = 'my_new_key';
			(actions.regenerateKey as SinonStub).resolves(newKey);

			await request(api)
				.post('/v1/regenerate-api-key')
				.set('Authorization', `Bearer ${oldKey}`)
				.expect(200)
				.then((response) => {
					expect(response.text).to.match(new RegExp(newKey));
				});
		});

		it('responds with 503 if regenerate was unsuccessful', async () => {
			const oldKey = await deviceApi.getGlobalApiKey();
			(actions.regenerateKey as SinonStub).throws(new Error());

			await request(api)
				.post('/v1/regenerate-api-key')
				.set('Authorization', `Bearer ${oldKey}`)
				.expect(503);
		});
	});
});
