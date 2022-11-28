import { expect } from 'chai';
import * as express from 'express';
import { SinonStub, stub } from 'sinon';
import * as request from 'supertest';

import * as config from '~/src/config';
import * as db from '~/src/db';
import * as deviceApi from '~/src/device-api';
import * as actions from '~/src/device-api/actions';
import * as v1 from '~/src/device-api/v1';
import { UpdatesLockedError } from '~/lib/errors';

// All routes that require Authorization are integration tests due to
// the api-key module relying on the database.
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

	describe('POST /v1/restart', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let doRestartStub: SinonStub;
		beforeEach(() => {
			doRestartStub = stub(actions, 'doRestart').resolves();
		});
		afterEach(async () => {
			doRestartStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v1/restart')
				.send({ appId: 1234567, force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(1234567, false);
			doRestartStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v1/restart')
				.send({ appId: 7654321, force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(7654321, true);
			doRestartStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v1/restart')
				.send({ appId: 7654321 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(7654321, false);
		});

		it('responds with 400 if appId is missing', async () => {
			await request(api)
				.post('/v1/restart')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v1/restart')
				.send({ appId: 7654321 })
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if restart succeeded', async () => {
			await request(api)
				.post('/v1/restart')
				.send({ appId: 1234567 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			doRestartStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v1/restart')
				.send({ appId: 1234567 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during restart', async () => {
			doRestartStub.throws(new Error());
			await request(api)
				.post('/v1/restart')
				.send({ appId: 1234567 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v1/purge', () => {
		let doPurgeStub: SinonStub;
		beforeEach(() => {
			doPurgeStub = stub(actions, 'doPurge').resolves();
		});
		afterEach(async () => {
			doPurgeStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v1/purge')
				.send({ appId: 1234567, force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(1234567, false);
			doPurgeStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v1/purge')
				.send({ appId: 7654321, force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(7654321, true);
			doPurgeStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v1/purge')
				.send({ appId: 7654321 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(7654321, false);
		});

		it('responds with 400 if appId is missing', async () => {
			await request(api)
				.post('/v1/purge')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v1/purge')
				.send({ appId: 7654321 })
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if purge succeeded', async () => {
			await request(api)
				.post('/v1/purge')
				.send({ appId: 1234567 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			doPurgeStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v1/purge')
				.send({ appId: 1234567 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during purge', async () => {
			doPurgeStub.throws(new Error());
			await request(api)
				.post('/v1/purge')
				.send({ appId: 1234567 })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});
});
