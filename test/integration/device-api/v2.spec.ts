import { expect } from 'chai';
import * as express from 'express';
import { SinonStub, stub } from 'sinon';
import * as request from 'supertest';

import * as config from '~/src/config';
import * as db from '~/src/db';
import * as deviceApi from '~/src/device-api';
import * as actions from '~/src/device-api/actions';
import * as v2 from '~/src/device-api/v2';
import {
	UpdatesLockedError,
	NotFoundError,
	BadRequestError,
} from '~/lib/errors';
import { supervisorVersion } from '~/src/lib/supervisor-version';

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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or missing serviceName/imageId from request body', async () => {
			await request(api)
				.post('/v2/applications/badAppId/stop-service')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service stop', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/stop-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or missing serviceName/imageId from request body', async () => {
			await request(api)
				.post('/v2/applications/badAppId/start-service')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service start', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/start-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
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
			const scopedKey = await deviceApi.generateScopedKey(1234567, 'main');
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
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 404 if app or service not found', async () => {
			executeServiceActionStub.throws(new NotFoundError());
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(404);
		});

		it('responds with 400 if invalid appId or missing serviceName/imageId from request body', async () => {
			await request(api)
				.post('/v2/applications/badAppId/restart-service')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);

			executeServiceActionStub.throws(new BadRequestError());
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(400);
		});

		it('responds with 423 if there are update locks', async () => {
			executeServiceActionStub.throws(new UpdatesLockedError());
			await request(api)
				.post('/v2/applications/1234567/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during service restart', async () => {
			executeServiceActionStub.throws(new Error());
			await request(api)
				.post('/v2/applications/7654321/restart-service')
				.send({ serviceName: 'test' })
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('GET /v2/device/vpn', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let getVPNStatusStub: SinonStub;
		before(() => {
			getVPNStatusStub = stub(actions, 'getVPNStatus');
		});
		after(() => {
			getVPNStatusStub.restore();
		});

		it('responds with 200 and vpn status', async () => {
			const vpnStatus = {
				active: true,
				connected: false,
			};
			getVPNStatusStub.resolves(vpnStatus);
			await request(api)
				.get('/v2/device/vpn')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200)
				.then(({ body }) => {
					expect(body).to.deep.equal({
						status: 'success',
						vpn: vpnStatus,
					});
				});
		});

		it('responds with 503 if an error occurred', async () => {
			getVPNStatusStub.throws(new Error());
			await request(api)
				.get('/v2/device/vpn')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('GET /v2/device/name', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let getDeviceNameStub: SinonStub;
		before(() => {
			getDeviceNameStub = stub(actions, 'getDeviceName');
		});
		after(() => {
			getDeviceNameStub.restore();
		});

		it('responds with 200 and device name', async () => {
			const deviceName = 'my-rpi4';
			getDeviceNameStub.resolves(deviceName);
			await request(api)
				.get('/v2/device/name')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200)
				.then(({ body }) => {
					expect(body).to.deep.equal({
						status: 'success',
						deviceName,
					});
				});
		});

		it('responds with 503 if an error occurred', async () => {
			getDeviceNameStub.throws(new Error());
			await request(api)
				.get('/v2/device/name')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('GET /v2/device/tags', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let getDeviceTagsStub: SinonStub;
		before(() => {
			getDeviceTagsStub = stub(actions, 'getDeviceTags');
		});
		after(() => {
			getDeviceTagsStub.restore();
		});

		it('responds with 200 and device tags', async () => {
			const tags = { id: 1, name: 'test', value: '' };
			getDeviceTagsStub.resolves(tags);
			await request(api)
				.get('/v2/device/tags')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200)
				.then(({ body }) => {
					expect(body).to.deep.equal({
						status: 'success',
						tags,
					});
				});
		});

		it('responds with 500 if an error occurred', async () => {
			getDeviceTagsStub.throws(new Error());
			await request(api)
				.get('/v2/device/tags')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(500);
		});
	});

	describe('GET /v2/cleanup-volumes', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let cleanupVolumesStub: SinonStub;
		before(() => {
			cleanupVolumesStub = stub(actions, 'cleanupVolumes');
		});
		after(() => {
			cleanupVolumesStub.restore();
		});

		it('responds with 200', async () => {
			cleanupVolumesStub.resolves();
			await request(api)
				.get('/v2/cleanup-volumes')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200);
		});

		it('responds with 503 if an error occurred', async () => {
			cleanupVolumesStub.throws(new Error());
			await request(api)
				.get('/v2/cleanup-volumes')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('POST /v2/journal-logs', () => {
		// Actions are tested elsewhere so we can stub the dependency here
		let getLogStreamStub: SinonStub;
		before(() => {
			getLogStreamStub = stub(actions, 'getLogStream');
		});
		after(() => {
			getLogStreamStub.restore();
		});

		it('responds with 200 and pipes journal stdout to response', async () => {
			getLogStreamStub.callThrough();

			await request(api)
				.post('/v2/journal-logs')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200)
				.then(({ text }) => {
					// journalctl in the sut service should be empty
					// as we don't log to it during testing
					expect(text).to.equal('-- No entries --\n');
				});
		});

		it('responds with 503 if an error occurred', async () => {
			getLogStreamStub.throws(new Error());
			await request(api)
				.post('/v2/journal-logs')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('GET /v2/version', () => {
		let getSupervisorVersionStub: SinonStub;
		before(() => {
			getSupervisorVersionStub = stub(actions, 'getSupervisorVersion');
		});
		after(() => {
			getSupervisorVersionStub.restore();
		});

		it('responds with 200 and Supervisor version', async () => {
			getSupervisorVersionStub.callThrough();
			await request(api)
				.get('/v2/version')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { status: 'success', version: supervisorVersion });
		});

		it('responds with 503 if an error occurred', async () => {
			getSupervisorVersionStub.throws(new Error());
			await request(api)
				.get('/v2/version')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});

	describe('GET /v2/containerId', () => {
		let getContainerIdStub: SinonStub;
		beforeEach(() => {
			getContainerIdStub = stub(actions, 'getContainerIds');
		});
		afterEach(() => {
			getContainerIdStub.restore();
		});

		it('accepts query parameters if they are strings', async () => {
			getContainerIdStub.resolves('test');
			await request(api)
				.get('/v2/containerId?serviceName=one')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { status: 'success', containerId: 'test' });
			expect(getContainerIdStub.firstCall.args[0]).to.equal('one');

			await request(api)
				.get('/v2/containerId?service=two')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { status: 'success', containerId: 'test' });
			expect(getContainerIdStub.secondCall.args[0]).to.equal('two');
		});

		it('ignores query parameters that are repeated', async () => {
			getContainerIdStub.resolves('test');
			await request(api)
				.get('/v2/containerId?serviceName=one&serviceName=two')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { status: 'success', containerId: 'test' });
			expect(getContainerIdStub.firstCall.args[0]).to.equal('');

			await request(api)
				.get('/v2/containerId?service=one&service=two')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { status: 'success', containerId: 'test' });
			expect(getContainerIdStub.secondCall.args[0]).to.equal('');
		});

		it('responds with 200 and single containerId', async () => {
			getContainerIdStub.resolves('test');
			await request(api)
				.get('/v2/containerId')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, { status: 'success', containerId: 'test' });
		});

		it('responds with 200 and multiple containerIds', async () => {
			getContainerIdStub.resolves({ one: 'abc', two: 'def' });
			await request(api)
				.get('/v2/containerId')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(200, {
					status: 'success',
					services: { one: 'abc', two: 'def' },
				});
		});

		it('responds with 503 if an error occurred', async () => {
			getContainerIdStub.throws(new Error());
			await request(api)
				.get('/v2/containerId')
				.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
				.expect(503);
		});
	});
});
