import { expect } from 'chai';
import type * as express from 'express';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import request from 'supertest';

import * as config from '~/src/config';
import * as db from '~/src/db';
import * as apiKeys from '~/lib/api-keys';
import * as deviceApi from '~/src/device-api';
import * as actions from '~/src/device-api/actions';
import * as v2 from '~/src/device-api/v2';
import {
	UpdatesLockedError,
	NotFoundError,
	BadRequestError,
} from '~/lib/errors';

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
			// @ts-expect-error extract private variable for testing
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
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(1234567, false);
			doRestartStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v2/applications/7654321/restart')
				.send({ force: true })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(7654321, true);
			doRestartStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v2/applications/7654321/restart')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(doRestartStub).to.have.been.calledWith(7654321, false);
		});

		it('responds with 400 if appId is missing', async () => {
			await request(api)
				.post('/v2/applications/badAppId/restart')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v2/applications/7654321/restart')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if restart succeeded', async () => {
			await request(api)
				.post('/v2/applications/1234567/restart')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			doRestartStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/restart')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during restart', async () => {
			doRestartStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/restart')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(1234567, false);
			doPurgeStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v2/applications/7654321/purge')
				.send({ force: true })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(7654321, true);
			doPurgeStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v2/applications/7654321/purge')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(doPurgeStub).to.have.been.calledWith(7654321, false);
		});

		it('responds with 400 if appId is missing', async () => {
			await request(api)
				.post('/v2/applications/badAppId/purge')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v2/applications/7654321/purge')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if purge succeeded', async () => {
			await request(api)
				.post('/v2/applications/1234567/purge')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			doPurgeStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/purge')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during purge', async () => {
			doPurgeStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/purge')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v2/applications/:appId/stop-service', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let executeServiceActionStub: SinonStub;
		beforeEach(() => {
			executeServiceActionStub = stub(
				actions,
				'executeServiceAction',
			).resolves();
		});
		afterEach(async () => {
			executeServiceActionStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ force: false, serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 1234567,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v2/applications/7654321/stop-service')
				.send({ force: true, serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 7654321,
				force: true,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v2/applications/7654321/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 7654321,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Parses imageId
			await request(api)
				.post('/v2/applications/7654321/stop-service')
				.send({ imageId: 111 })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 7654321,
				force: false,
				imageId: 111,
				serviceName: undefined,
			});
			executeServiceActionStub.resetHistory();

			// Parses serviceName
			await request(api)
				.post('/v2/applications/7654321/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 7654321,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v2/applications/7654321/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if service stop succeeded', async () => {
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or missing serviceName/imageId from request body', async () => {
			await request(api)
				.post('/v2/applications/badAppId/stop-service')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service stop', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v2/applications/:appId/start-service', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let executeServiceActionStub: SinonStub;
		beforeEach(() => {
			executeServiceActionStub = stub(
				actions,
				'executeServiceAction',
			).resolves();
		});
		afterEach(async () => {
			executeServiceActionStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ force: false, serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 1234567,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v2/applications/7654321/start-service')
				.send({ force: true, serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 7654321,
				force: true,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v2/applications/7654321/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 7654321,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Parses imageId
			await request(api)
				.post('/v2/applications/7654321/start-service')
				.send({ imageId: 111 })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 7654321,
				force: false,
				imageId: 111,
				serviceName: undefined,
			});
			executeServiceActionStub.resetHistory();

			// Parses serviceName
			await request(api)
				.post('/v2/applications/7654321/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 7654321,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v2/applications/7654321/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if service start succeeded', async () => {
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or missing serviceName/imageId from request body', async () => {
			await request(api)
				.post('/v2/applications/badAppId/start-service')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service start', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v2/applications/:appId/restart-service', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let executeServiceActionStub: SinonStub;
		beforeEach(() => {
			executeServiceActionStub = stub(
				actions,
				'executeServiceAction',
			).resolves();
		});
		afterEach(async () => {
			executeServiceActionStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ force: false, serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'restart',
				appId: 1234567,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v2/applications/7654321/restart-service')
				.send({ force: true, serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'restart',
				appId: 7654321,
				force: true,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v2/applications/7654321/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'restart',
				appId: 7654321,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
			executeServiceActionStub.resetHistory();

			// Parses imageId
			await request(api)
				.post('/v2/applications/7654321/restart-service')
				.send({ imageId: 111 })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'restart',
				appId: 7654321,
				force: false,
				imageId: 111,
				serviceName: undefined,
			});
			executeServiceActionStub.resetHistory();

			// Parses serviceName
			await request(api)
				.post('/v2/applications/7654321/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'restart',
				appId: 7654321,
				force: false,
				imageId: undefined,
				serviceName: 'test',
			});
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v2/applications/7654321/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if service restart succeeded', async () => {
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or missing serviceName/imageId from request body', async () => {
			await request(api)
				.post('/v2/applications/badAppId/restart-service')
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service restart', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(503);
		});
	});
});
