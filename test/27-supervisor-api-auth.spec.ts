import { expect } from 'chai';
import * as requestLib from 'request';
import Config from '../src/config';
import Database from '../src/db';
import EventTracker from '../src/event-tracker';
import SupervisorAPI from '../src/supervisor-api';

const mockedOptions = {
	listenPort: 48484,
	timeout: 30000,
};

const VALID_SECRET = 'secure_api_secret';
const INVALID_SECRET = 'bad_api_secret';
const ALLOWED_INTERFACES = ['lo']; // Only need loopback since this is for testing

describe('SupervisorAPI authentication', () => {
	let api: SupervisorAPI;
	const mockedConfig = new Config({ db: new Database() });
	// Set apiSecret that we can test with
	mockedConfig.set({ apiSecret: VALID_SECRET });

	before(() => {
		api = new SupervisorAPI({
			config: mockedConfig,
			eventTracker: new EventTracker(),
			routers: [],
			healthchecks: [],
		});
		return api.listen(
			ALLOWED_INTERFACES,
			mockedOptions.listenPort,
			mockedOptions.timeout,
		);
	});

	after(done => {
		api.stop();
		done();
	});

	it('finds no apiKey and rejects', async () => {
		const response = await postAsync('/v1/blink');
		expect(response.statusCode).to.equal(401);
	});

	it('finds apiKey from query', async () => {
		const response = await postAsync(`/v1/blink?apikey=${VALID_SECRET}`);
		expect(response.statusCode).to.equal(200);
	});

	it('finds apiKey from Authorization header (ApiKey scheme)', async () => {
		const response = await postAsync(`/v1/blink`, {
			Authorization: `ApiKey ${VALID_SECRET}`,
		});
		expect(response.statusCode).to.equal(200);
	});

	it('rejects invalid apiKey from query', async () => {
		const response = await postAsync(`/v1/blink?apikey=${INVALID_SECRET}`);
		expect(response.statusCode).to.equal(401);
	});

	it('rejects apiKey from Authorization header (ApiKey scheme)', async () => {
		const response = await postAsync(`/v1/blink`, {
			Authorization: `ApiKey ${INVALID_SECRET}`,
		});
		expect(response.statusCode).to.equal(401);
	});
});

function postAsync(path: string, headers = {}): Promise<any> {
	return new Promise((resolve, reject) => {
		requestLib.post(
			{
				url: `http://127.0.0.1:${mockedOptions.listenPort}${path}`,
				headers,
			},
			(error: Error, response: requestLib.Response) => {
				if (error) {
					reject(error);
				}
				resolve(response);
			},
		);
	});
}
