import * as apiBinder from './api-binder';
import * as db from './db';
import * as config from './config';
import * as deviceState from './device-state';
import * as logger from './logging';
import SupervisorAPI from './device-api';
import * as v1 from './device-api/v1';
import * as v2 from './device-api/v2';
import logMonitor from './logging/monitor';
import * as memory from './memory';

import { initializeContractRequirements } from './lib/contracts';
import { normaliseLegacyDatabase } from './lib/legacy';
import * as osRelease from './lib/os-release';
import log from './lib/supervisor-console';
import version = require('./lib/supervisor-version');
import * as avahi from './lib/avahi';
import * as firewall from './lib/firewall';

const startupConfigFields: config.ConfigKey[] = [
	'uuid',
	'listenPort',
	'apiEndpoint',
	'apiTimeout',
	'unmanaged',
	'deviceApiKey',
	'loggingEnabled',
	'localMode',
	'legacyAppsPresent',
];

export class Supervisor {
	private api: SupervisorAPI;

	public async init() {
		log.info(`Supervisor v${version} starting up...`);

		await db.initialized();
		await config.initialized();
		await avahi.initialized();
		log.debug('Starting logging infrastructure');
		await logger.initialized();

		const conf = await config.getMany(startupConfigFields);

		initializeContractRequirements({
			supervisorVersion: version,
			deviceType: await config.get('deviceType'),
			deviceArch: await config.get('deviceArch'),
			l4tVersion: await osRelease.getL4tVersion(),
		});

		log.info('Starting firewall');
		await firewall.initialised();

		log.debug('Starting api binder');
		await apiBinder.initialized();

		await deviceState.initialized();

		const unmanaged = await config.get('unmanaged');
		logger.logSystemMessage('Supervisor starting', {}, 'Supervisor start');
		if (conf.legacyAppsPresent && !unmanaged) {
			log.info('Legacy app detected, running migration');
			await normaliseLegacyDatabase();
		}

		// Start the state engine, the device API and API binder in parallel
		await Promise.all([
			deviceState.loadInitialState(),
			(() => {
				log.info('Starting API server');
				this.api = new SupervisorAPI({
					routers: [v1.router, v2.router],
					healthchecks: [
						apiBinder.healthcheck,
						deviceState.healthcheck,
						memory.healthcheck,
					],
				});
				deviceState.on('shutdown', () => this.api.stop());
				return this.api.listen(conf.listenPort, conf.apiTimeout);
			})(),
			apiBinder.start(),
		]);

		await logMonitor.start();
	}
}

export default Supervisor;
