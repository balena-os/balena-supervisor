import { expect } from 'chai';
import * as express from 'express';
import { SinonStub, stub } from 'sinon';
import * as request from 'supertest';

import * as config from '~/src/config';
import * as db from '~/src/db';
import * as deviceApi from '~/src/device-api';
import * as actions from '~/src/device-api/actions';
import * as v2 from '~/src/device-api/v2';
import { UpdatesLockedError } from '~/lib/errors';

// All routes that require Authorization are integration tests due to
// the api-key module relying on the database.
describe('device-api/v2', () => {
	let api: express.Application;

	before(async () => {
		await config.initialized();

		// `api` is a private property on SupervisorAPI but
		// passing it directly to supertest is easier than
		// setting up an API listen port & timeout
		api = new deviceApi.SupervisorAPI({
			routers: [v2.router],
			healthchecks: [],
			// @ts-expect-error
		}).api;
	});

	describe('POST /v2/applications/:appId/restart', () => {
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
				.post('/v2/applications/1234567/restart')
				.send({ force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(1234567, false);
			doRestartStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v2/applications/7654321/restart')
				.send({ force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(7654321, true);
			doRestartStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v2/applications/7654321/restart')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(7654321, false);
		});

		it('responds with 400 if appId is missing', async () => {
			await request(api)
				.post('/v2/applications/badAppId/restart')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v2/applications/7654321/restart')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if restart succeeded', async () => {
			await request(api)
				.post('/v2/applications/1234567/restart')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			doRestartStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/restart')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during restart', async () => {
			doRestartStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/restart')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v2/applications/:appId/purge', () => {
		// Actions are tested elsewhere so we can stub the dependency here
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
				.post('/v2/applications/1234567/purge')
				.send({ force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(1234567, false);
			doPurgeStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v2/applications/7654321/purge')
				.send({ force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(7654321, true);
			doPurgeStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v2/applications/7654321/purge')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(7654321, false);
		});

		it('responds with 400 if appId is missing', async () => {
			await request(api)
				.post('/v2/applications/badAppId/purge')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v2/applications/7654321/purge')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if purge succeeded', async () => {
			await request(api)
				.post('/v2/applications/1234567/purge')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			doPurgeStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/purge')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during purge', async () => {
			doPurgeStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/purge')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});
});
