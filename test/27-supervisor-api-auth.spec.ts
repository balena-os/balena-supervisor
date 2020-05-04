import { expect } from 'chai';
import { fs } from 'mz';
import * as requestLib from 'request';

import Config from '../src/config';
import Database from '../src/db';
import EventTracker from '../src/event-tracker';
import SupervisorAPI from '../src/supervisor-api';

const mockedOptions = {
	listenPort: 12345,
	timeout: 30000,
	dbPath: './test/data/supervisor-api.sqlite',
};

const VALID_SECRET = 'secure_api_secret';
const INVALID_SECRET = 'bad_api_secret';
const ALLOWED_INTERFACES = ['lo']; // Only need loopback since this is for testing

describe('SupervisorAPI authentication', () => {
	let api: SupervisorAPI;

	before(async () => {
		const db = new Database({
			databasePath: mockedOptions.dbPath,
		});
		await db.init();
		const mockedConfig = new Config({ db });
		await mockedConfig.init();
		// Set apiSecret that we can test with
		await mockedConfig.set({ apiSecret: VALID_SECRET });
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

	after(async () => {
		api.stop();
		try {
			await fs.unlink(mockedOptions.dbPath);
		} catch (e) {
			/* noop */
		}
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

	it('finds apiKey from Authorization header (Bearer scheme)', async () => {
		const response = await postAsync(`/v1/blink`, {
			Authorization: `Bearer ${VALID_SECRET}`,
		});
		expect(response.statusCode).to.equal(200);
	});

	it('finds apiKey from Authorization header (case insensitive)', async () => {
		const randomCases = [
			'Bearer',
			'bearer',
			'BEARER',
			'BeAReR',
			'ApiKey',
			'apikey',
			'APIKEY',
			'ApIKeY',
		];
		for (const scheme of randomCases) {
			const response = await postAsync(`/v1/blink`, {
				Authorization: `${scheme} ${VALID_SECRET}`,
			});
			expect(response.statusCode).to.equal(200);
		}
	});

	it('rejects invalid apiKey from query', async () => {
		const response = await postAsync(`/v1/blink?apikey=${INVALID_SECRET}`);
		expect(response.statusCode).to.equal(401);
	});

	it('rejects invalid apiKey from Authorization header (ApiKey scheme)', async () => {
		const response = await postAsync(`/v1/blink`, {
			Authorization: `ApiKey ${INVALID_SECRET}`,
		});
		expect(response.statusCode).to.equal(401);
	});

	it('rejects invalid apiKey from Authorization header (Bearer scheme)', async () => {
		const response = await postAsync(`/v1/blink`, {
			Authorization: `Bearer ${INVALID_SECRET}`,
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
