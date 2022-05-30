import { stub, restore, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import * as config from '../../../src/config';
import SupervisorAPI from '../../../src/device-api';
import * as actions from '../../../src/device-api/actions';
import * as v1 from '../../../src/device-api/v1';
import * as apiKeys from '../../../src/device-api/api-keys';
import * as middleware from '../../../src/device-api/middleware';
import log from '../../../src/lib/supervisor-console';

describe('device-api/v1', () => {
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
			routers: [v1.router],
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

	describe('GET /v1/healthy', () => {
		let runHealthchecksStub: SinonStub;

		beforeEach(() => {
			runHealthchecksStub = stub(actions, 'runHealthchecks');
		});
		afterEach(() => runHealthchecksStub.restore());

		it('responds with 200 because all healthchecks pass', async () => {
			runHealthchecksStub.resolves(true);
			await request
				.get('/v1/healthy')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});

		it('responds with 500 because some healthchecks did not pass', async () => {
			runHealthchecksStub.resolves(false);
			await request
				.get('/v1/healthy')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(500, 'Unhealthy');
		});
	});

	describe('POST /v1/blink', () => {
		let identifyStub: SinonStub;

		beforeEach(() => {
			identifyStub = stub(actions, 'identify');
		});
		afterEach(() => identifyStub.restore());

		it('responds with 200', async () => {
			await request
				.post('/v1/blink')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});
	});
});
