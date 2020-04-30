import { expect } from 'chai';
import { fs } from 'mz';
import { spy } from 'sinon';

import Config from '../src/config';
import Database from '../src/db';
import EventTracker from '../src/event-tracker';
import Log from '../src/lib/supervisor-console';
import SupervisorAPI from '../src/supervisor-api';

const mockedOptions = {
	listenPort: 12345,
	timeout: 30000,
	dbPath: './test/data/supervisor-api.sqlite',
};

const ALLOWED_INTERFACES = ['lo']; // Only need loopback since this is for testing

describe('SupervisorAPI', () => {
	describe('State change logging', () => {
		let api: SupervisorAPI;
		let db: Database;
		let mockedConfig: Config;

		before(async () => {
			db = new Database({
				databasePath: mockedOptions.dbPath,
			});
			await db.init();
			mockedConfig = new Config({ db });
			await mockedConfig.init();
		});

		beforeEach(async () => {
			api = new SupervisorAPI({
				config: mockedConfig,
				eventTracker: new EventTracker(),
				routers: [],
				healthchecks: [],
			});
			spy(Log, 'info');
			spy(Log, 'error');
		});

		afterEach(async () => {
			// @ts-ignore
			Log.info.restore();
			// @ts-ignore
			Log.error.restore();
			try {
				await api.stop();
			} catch (e) {
				if (e.message !== 'Server is not running.') {
					// Ignore since server is already closed
					throw e;
				}
			}
		});

		after(async () => {
			try {
				await fs.unlink(mockedOptions.dbPath);
			} catch (e) {
				/* noop */
			}
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
