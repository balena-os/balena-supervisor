import { expect } from 'chai';
import { spy, stub, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import * as APIBinder from '../src/api-binder';
import * as deviceState from '../src/device-state';
import Log from '../src/lib/supervisor-console';
import * as images from '../src/compose/images';
import SupervisorAPI from '../src/supervisor-api';
import sampleResponses = require('./data/device-api-responses.json');
import mockedAPI = require('./lib/mocked-device-api');

const mockedOptions = {
	listenPort: 54321,
	timeout: 30000,
};

const VALID_SECRET = mockedAPI.STUBBED_VALUES.config.apiSecret;

describe('SupervisorAPI', () => {
	let api: SupervisorAPI;
	let healthCheckStubs: SinonStub[];
	const request = supertest(`http://127.0.0.1:${mockedOptions.listenPort}`);
	const originalGetStatus = images.getStatus;

	before(async () => {
		// Stub health checks so we can modify them whenever needed
		healthCheckStubs = [
			stub(APIBinder, 'healthcheck'),
			stub(deviceState, 'healthcheck'),
		];
		// The mockedAPI contains stubs that might create unexpected results
		// See the module to know what has been stubbed
		api = await mockedAPI.create();

		// @ts-expect-error assigning to a RO property
		images.getStatus = () => Promise.resolve([]);

		// Start test API
		return api.listen(mockedOptions.listenPort, mockedOptions.timeout);
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e) {
			if (e.message !== 'Server is not running.') {
				throw e;
			}
		}
		// Restore healthcheck stubs
		healthCheckStubs.forEach((hc) => hc.restore);
		// Remove any test data generated
		await mockedAPI.cleanUp();

		// @ts-expect-error assigning to a RO property
		images.getStatus = originalGetStatus;
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

	describe('V1 endpoints', () => {
		describe('GET /v1/healthy', () => {
			it('returns OK because all checks pass', async () => {
				// Make all healthChecks pass
				healthCheckStubs.forEach((hc) => hc.resolves(true));
				await request
					.get('/v1/healthy')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${VALID_SECRET}`)
					.expect(sampleResponses.V1.GET['/healthy'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V1.GET['/healthy'].body,
						);
						expect(response.text).to.deep.equal(
							sampleResponses.V1.GET['/healthy'].text,
						);
					});
			});
			it('Fails because some checks did not pass', async () => {
				// Make one of the healthChecks fail
				healthCheckStubs[0].resolves(false);
				await request
					.get('/v1/healthy')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${VALID_SECRET}`)
					.expect(sampleResponses.V1.GET['/healthy [2]'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V1.GET['/healthy [2]'].body,
						);
						expect(response.text).to.deep.equal(
							sampleResponses.V1.GET['/healthy [2]'].text,
						);
					});
			});
		});
		// TODO: add tests for V1 endpoints
		describe('GET /v1/device', () => {
			it('returns MAC address', async () => {
				const response = await request
					.get('/v1/device')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${VALID_SECRET}`)
					.expect(200);

				expect(response.body).to.have.property('mac_address').that.is.not.empty;
			});
		});
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

		describe('GET /v2/applications/:appId/state', () => {
			it('returns information about a SPECIFIC application', async () => {
				await request
					.get('/v2/applications/1/state')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${VALID_SECRET}`)
					.expect('Content-Type', /json/)
					.expect(sampleResponses.V2.GET['/applications/1/state'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V2.GET['/applications/1/state'].body,
						);
					});
			});

			it('returns 400 for invalid appId', async () => {
				await request
					.get('/v2/applications/123invalid/state')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${VALID_SECRET}`)
					.expect('Content-Type', /json/)
					.expect(
						sampleResponses.V2.GET['/applications/123invalid/state'].statusCode,
					)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V2.GET['/applications/123invalid/state'].body,
						);
					});
			});

			it('returns 409 because app does not exist', async () => {
				await request
					.get('/v2/applications/9000/state')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${VALID_SECRET}`)
					.expect('Content-Type', /json/)
					.expect(sampleResponses.V2.GET['/applications/9000/state'].statusCode)
					.then((response) => {
						expect(response.body).to.deep.equal(
							sampleResponses.V2.GET['/applications/9000/state'].body,
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
			return api.listen(mockedOptions.listenPort, mockedOptions.timeout);
		});

		it('logs successful start', async () => {
			// Start API
			await api.listen(mockedOptions.listenPort, mockedOptions.timeout);
			// Check if success start was logged
			// @ts-ignore
			expect(Log.info.lastCall?.lastArg).to.equal(
				`Supervisor API successfully started on port ${mockedOptions.listenPort}`,
			);
		});

		it('logs shutdown', async () => {
			// Start API
			await api.listen(mockedOptions.listenPort, mockedOptions.timeout);
			// Stop API
			await api.stop();
			// Check if stopped with info was logged
			// @ts-ignore
			expect(Log.info.lastCall?.lastArg).to.equal('Stopped Supervisor API');
		});

		it('logs errored shutdown', async () => {
			// Start API
			await api.listen(mockedOptions.listenPort, mockedOptions.timeout);
			// Stop API with error
			await api.stop({ errored: true });
			// Check if stopped with error was logged
			// @ts-ignore
			expect(Log.error.lastCall?.lastArg).to.equal('Stopped Supervisor API');
		});
	});
});
