import * as express from 'express';
import * as request from 'supertest';
import { SinonStub } from 'sinon';
import { expect } from 'chai';

import * as middleware from '~/src/device-api/middleware';
import { UpdatesLockedError } from '~/lib/errors';
import log from '~/lib/supervisor-console';

describe('device-api/middleware', () => {
	let app: express.Application;

	describe('errors', () => {
		before(() => {
			app = express();
			app.get('/locked', (_req, _res) => {
				throw new UpdatesLockedError();
			});
			app.get('/errored', (_req, _res) => {
				throw new Error();
			});
			app.use(middleware.errors);
		});

		it('responds with 423 if updates are locked', async () => {
			await request(app).get('/locked').expect(423);
		});

		it('responds with 503 if any other error', async () => {
			await request(app).get('/errored').expect(503);
		});
	});

	describe('logging', () => {
		before(() => {
			app = express();
			app.use(middleware.logging);
			app.get('/', (_req, res) => res.sendStatus(200));
			app.post('/', (_req, res) => res.sendStatus(304));
			(log.api as SinonStub).reset();
		});

		it('logs API request methods and status codes', async () => {
			await request(app).get('/');
			expect((log.api as SinonStub).lastCall?.firstArg).to.match(/get.*200/i);

			await request(app).post('/');
			expect((log.api as SinonStub).lastCall?.firstArg).to.match(/post.*304/i);
		});
	});
});
