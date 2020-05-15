import { expect } from 'chai';
import { spy } from 'sinon';
import * as supertest from 'supertest';

import Log from '../src/lib/supervisor-console';
import SupervisorAPI from '../src/supervisor-api';
import sampleResponses = require('./data/device-api-responses.json');
import mockedAPI = require('./lib/mocked-device-api');

const mockedOptions = {
	listenPort: 54321,
	timeout: 30000,
};

const VALID_SECRET = mockedAPI.DEFAULT_SECRET;
const ALLOWED_INTERFACES = ['lo']; // Only need loopback since this is for testing

describe('SupervisorAPI', () => {
	let api: SupervisorAPI;
	const request = supertest(`http://127.0.0.1:${mockedOptions.listenPort}`);

	before(async () => {
		// Create test API
		api = await mockedAPI.create();
		// Start test API
		return api.listen(
			ALLOWED_INTERFACES,
			mockedOptions.listenPort,
			mockedOptions.timeout,
		);
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e) {
			if (e.message !== 'Server is not running.') {
				throw e;
			}
		}
		// Remove any test data generated
		await mockedAPI.cleanUp();
	});

	describe('/ping', () => {
		it('responds with OK (without auth)', async () => {
			await request.get('/ping').set('Accept', 'application/json').expect(200);
		});
		it('responds with OK (with auth)', async () => {
			await request
				.get('/ping')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${VALID_SECRET}`)
				.expect(200);
		});
	});

	describe.skip('V1 endpoints', () => {
		// TODO: add tests for V1 endpoints
	});

	describe('V2 endpoints', () => {
		describe('GET /v2/device/vpn', () => {
			it('returns information about VPN connection', async () => {
				await request
					.get('/v2/device/vpn')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${VALID_SECRET}`)
					.expect('Content-Type', /json/)
					.expect(sampleResponses.V2.GET['/device/vpn'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V2.GET['/device/vpn'].body,
						);
					});
			});
		});
		// TODO: add tests for rest of V2 endpoints
	});

	describe('State change logging', () => {
		before(() => {
			// Spy on functions we will be testing
			spy(Log, 'info');
			spy(Log, 'error');
		});

		beforeEach(async () => {
			// Start each case with API stopped
			try {
				await api.stop();
			} catch (e) {
				if (e.message !== 'Server is not running.') {
					throw e;
				}
			}
		});

		after(async () => {
			// @ts-ignore
			Log.info.restore();
			// @ts-ignore
			Log.error.restore();
			// Resume API for other test suites
			return api.listen(
				ALLOWED_INTERFACES,
				mockedOptions.listenPort,
				mockedOptions.timeout,
			);
		});

		it('logs successful start', async () => {
			// Start API
			await api.listen(
				ALLOWED_INTERFACES,
				mockedOptions.listenPort,
				mockedOptions.timeout,
			);
			// Check if success start was logged
			// @ts-ignore
			expect(Log.info.lastCall?.lastArg).to.equal(
				`Supervisor API successfully started on port ${mockedOptions.listenPort}`,
			);
		});

		it('logs shutdown', async () => {
			// Start API
			await api.listen(
				ALLOWED_INTERFACES,
				mockedOptions.listenPort,
				mockedOptions.timeout,
			);
			// Stop API
			await api.stop();
			// Check if stopped with info was logged
			// @ts-ignore
			expect(Log.info.lastCall?.lastArg).to.equal('Stopped Supervisor API');
		});

		it('logs errored shutdown', async () => {
			// Start API
			await api.listen(
				ALLOWED_INTERFACES,
				mockedOptions.listenPort,
				mockedOptions.timeout,
			);
			// Stop API with error
			await api.stop({ errored: true });
			// Check if stopped with error was logged
			// @ts-ignore
			expect(Log.error.lastCall?.lastArg).to.equal('Stopped Supervisor API');
		});
	});
});
