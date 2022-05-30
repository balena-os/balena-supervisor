import { expect } from 'chai';
import { stub, restore, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import SupervisorAPI from '../../../src/device-api';
import { actions, apiKeys, middleware, v2 } from '../../../src/device-api';
import * as config from '../../../src/config';
import log from '../../../src/lib/supervisor-console';
import { UpdatesLockedError } from '../../../src/lib/errors';

describe('device-api/v2', () => {
	let api: SupervisorAPI;
	let request: supertest.SuperTest<supertest.Test>;
	const API_PORT = 54321;
	const API_TIMEOUT = 30000;

	before(async () => {
		// Disable log output during testing
		stub(log, 'debug');
		stub(log, 'warn');
		stub(log, 'info');
		stub(log, 'event');
		stub(log, 'success');
		stub(log, 'error');

		// Disable API logger during testing
		stub(middleware, 'apiLogger').callsFake((_req, _res, next) => next());

		// Stub config module to avoid attempts to get sqlite3 configs
		stub(config, 'getMany').callsFake(
			async (_confs): Promise<any> => {
				// middleware.auth requires getting unmanaged and localMode configs
				return Promise.resolve({
					unmanaged: false,
					localMode: false,
				});
			},
		);

		request = supertest(`http://127.0.0.1:${API_PORT}`);
		api = new SupervisorAPI({
			routers: [v2.router],
			healthchecks: [],
		});
		await api.listen(API_PORT, API_TIMEOUT);
		// Generate initial key so test requests have valid auth
		await apiKeys.generateCloudKey();
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e) {
			if ((e as Error).message !== 'Server is not running.') {
				throw e;
			}
		}

		// Restore sinon stubs
		restore();
	});

	describe('POST /v2/applications/:appId/restart', () => {
		let restartStub: SinonStub;

		beforeEach(() => {
			restartStub = stub(actions, 'doRestart').resolves();
		});
		afterEach(() => restartStub.restore());

		it('parses force from request body', async () => {
			await request
				.post('/v2/applications/1234567/restart')
				.send({ force: false })
				.set('Content-Type', 'application/json')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
			expect(restartStub).to.have.been.calledWith(1234567, false);

			restartStub.resetHistory();

			await request
				.post('/v2/applications/7654321/restart')
				.send({ force: true })
				.set('Content-Type', 'application/json')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
			expect(restartStub).to.have.been.calledWith(7654321, true);
		});

		it('responds with 400 if appId is missing', async () => {
			await request
				.post('/v2/applications/badAppId/restart')
				.send({})
				.set('Content-Type', 'application/json')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			await request
				.post('/v2/applications/7654321/restart')
				.set('Content-Type', 'application/json')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if restart succeeded', async () => {
			await request
				.post('/v2/applications/1234567/restart')
				.set('Content-Type', 'application/json')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			restartStub.throws(new UpdatesLockedError());
			await request
				.post('/v2/applications/1234567/restart')
				.set('Content-Type', 'application/json')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during restart', async () => {
			restartStub.throws(new Error());
			await request
				.post('/v2/applications/1234567/restart')
				.set('Content-Type', 'application/json')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(503);
		});
	});
});
