import { expect } from 'chai';
import * as express from 'express';
import { SinonStub, stub } from 'sinon';
import * as request from 'supertest';

import * as config from '~/src/config';
import * as db from '~/src/db';
import Service from '~/src/compose/service';
import * as deviceApi from '~/src/device-api';
import * as actions from '~/src/device-api/actions';
import * as v1 from '~/src/device-api/v1';
import {
	UpdatesLockedError,
	NotFoundError,
	BadRequestError,
} from '~/lib/errors';

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

	describe('POST /v1/apps/:appId/stop', () => {
		let executeServiceActionStub: SinonStub;
		let getLegacyServiceStub: SinonStub;
		beforeEach(() => {
			executeServiceActionStub = stub(
				actions,
				'executeServiceAction',
			).resolves();
			getLegacyServiceStub = stub(actions, 'getLegacyService').resolves({
				containerId: 'abcdef',
			} as Service);
		});
		afterEach(async () => {
			executeServiceActionStub.restore();
			getLegacyServiceStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v1/apps/1234567/stop')
				.send({ force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 1234567,
				force: false,
				isLegacy: true,
			});
			executeServiceActionStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v1/apps/7654321/stop')
				.send({ force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 7654321,
				force: true,
				isLegacy: true,
			});
			executeServiceActionStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v1/apps/7654321/stop')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'stop',
				appId: 7654321,
				force: false,
				isLegacy: true,
			});
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v1/apps/7654321/stop')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 and containerId if service stop succeeded if service stop succeeded', async () => {
			await request(api)
				.post('/v1/apps/1234567/stop')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { containerId: 'abcdef' });
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v1/apps/1234567/stop')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or appId corresponds to a multicontainer release', async () => {
			await request(api)
				.post('/v1/apps/badAppId/stop')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v1/apps/1234567/stop')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v1/apps/1234567/stop')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service stop', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v1/apps/1234567/stop')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v1/apps/:appId/start', () => {
		let executeServiceActionStub: SinonStub;
		let getLegacyServiceStub: SinonStub;
		beforeEach(() => {
			executeServiceActionStub = stub(
				actions,
				'executeServiceAction',
			).resolves();
			getLegacyServiceStub = stub(actions, 'getLegacyService').resolves({
				containerId: 'abcdef',
			} as Service);
		});
		afterEach(async () => {
			executeServiceActionStub.restore();
			getLegacyServiceStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v1/apps/1234567/start')
				.send({ force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 1234567,
				force: false,
				isLegacy: true,
			});
			executeServiceActionStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v1/apps/7654321/start')
				.send({ force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 7654321,
				force: true,
				isLegacy: true,
			});
			executeServiceActionStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v1/apps/7654321/start')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
			expect(executeServiceActionStub).to.have.been.calledWith({
				action: 'start',
				appId: 7654321,
				force: false,
				isLegacy: true,
			});
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
			await request(api)
				.post('/v1/apps/7654321/start')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 and containerId if service start succeeded', async () => {
			await request(api)
				.post('/v1/apps/1234567/start')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { containerId: 'abcdef' });
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v1/apps/1234567/start')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or appId corresponds to a multicontainer release', async () => {
			await request(api)
				.post('/v1/apps/badAppId/start')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v1/apps/1234567/start')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v1/apps/1234567/start')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service start', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v1/apps/1234567/start')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v1/reboot', () => {
		let executeDeviceActionStub: SinonStub;
		beforeEach(() => {
			executeDeviceActionStub = stub(actions, 'executeDeviceAction').resolves();
		});
		afterEach(async () => executeDeviceActionStub.restore());

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v1/reboot')
				.send({ force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(executeDeviceActionStub).to.have.been.calledWith(
				{
					action: 'reboot',
				},
				false,
			);
			executeDeviceActionStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v1/reboot')
				.send({ force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(executeDeviceActionStub).to.have.been.calledWith(
				{
					action: 'reboot',
				},
				true,
			);
			executeDeviceActionStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v1/reboot')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(executeDeviceActionStub).to.have.been.calledWith(
				{
					action: 'reboot',
				},
				false,
			);
		});

		it('responds with 202 if request successful', async () => {
			await request(api)
				.post('/v1/reboot')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(202);
		});

		it('responds with 423 if there are update locks', async () => {
			executeDeviceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v1/reboot')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 500 for other errors that occur during reboot', async () => {
			executeDeviceActionStub.throws(new Error());
			await request(api)
				.post('/v1/reboot')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(500);
		});
	});

	describe('POST /v1/shutdown', () => {
		let executeDeviceActionStub: SinonStub;
		beforeEach(() => {
			executeDeviceActionStub = stub(actions, 'executeDeviceAction').resolves();
		});
		afterEach(async () => executeDeviceActionStub.restore());

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v1/shutdown')
				.send({ force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(executeDeviceActionStub).to.have.been.calledWith(
				{
					action: 'shutdown',
				},
				false,
			);
			executeDeviceActionStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v1/shutdown')
				.send({ force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(executeDeviceActionStub).to.have.been.calledWith(
				{
					action: 'shutdown',
				},
				true,
			);
			executeDeviceActionStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v1/shutdown')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(executeDeviceActionStub).to.have.been.calledWith(
				{
					action: 'shutdown',
				},
				false,
			);
		});

		it('responds with 202 if request successful', async () => {
			await request(api)
				.post('/v1/shutdown')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(202);
		});

		it('responds with 423 if there are update locks', async () => {
			executeDeviceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v1/shutdown')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 500 for other errors that occur during shutdown', async () => {
			executeDeviceActionStub.throws(new Error());
			await request(api)
				.post('/v1/shutdown')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(500);
		});
	});

	describe('POST /v1/update', () => {
		let updateTargetStub: SinonStub;
		beforeEach(() => {
			updateTargetStub = stub(actions, 'updateTarget');
		});
		afterEach(async () => updateTargetStub.restore());

		it('validates data from request body', async () => {
			// Parses force: false
			await request(api)
				.post('/v1/update')
				.send({ force: false })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(updateTargetStub.lastCall.firstArg).to.be.false;
			updateTargetStub.resetHistory();

			// Parses force: true
			await request(api)
				.post('/v1/update')
				.send({ force: true })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(updateTargetStub.lastCall.firstArg).to.be.true;
			updateTargetStub.resetHistory();

			// Defaults to force: false
			await request(api)
				.post('/v1/update')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(updateTargetStub.lastCall.firstArg).to.be.false;
		});

		it('responds with 204 if update triggered', async () => {
			updateTargetStub.returns(true);
			await request(api)
				.post('/v1/update')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(204);
		});

		it('responds with 202 if update not triggered', async () => {
			updateTargetStub.returns(false);
			await request(api)
				.post('/v1/update')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(202);
		});
	});

	describe('GET /v1/apps/:appId', () => {
		let getSingleContainerAppStub: SinonStub;
		beforeEach(() => {
			getSingleContainerAppStub = stub(
				actions,
				'getSingleContainerApp',
			).resolves({} as any);
		});
		afterEach(async () => {
			getSingleContainerAppStub.restore();
			// Remove all scoped API keys between tests
			await db.models('apiSecret').whereNot({ appId: 0 }).del();
		});

		it('validates data from request body', async () => {
			await request(api)
				.get('/v1/apps/1234567')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`);
			expect(getSingleContainerAppStub).to.have.been.calledWith(1234567);
		});

		it('responds with 200 if request successful', async () => {
			await request(api)
				.get('/v1/apps/1234567')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, {});
		});

		it('responds with 400 if invalid appId parameter', async () => {
			await request(api)
				.get('/v1/apps/badAppId')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 400 if action throws BadRequestError', async () => {
			getSingleContainerAppStub.throws(new BadRequestError());
			await request(api)
				.get('/v1/apps/1234567')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await deviceApi.generateScopedKey(7654321, 'main');
			await request(api)
				.get('/v1/apps/1234567')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 503 for other errors that occur during request', async () => {
			getSingleContainerAppStub.throws(new Error());
			await request(api)
				.get('/v1/apps/1234567')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});
});
