import APIBinder from './api-binder';
import Config, { ConfigKey } from './config';
import * as db from './db';
import DeviceState from './device-state';
import EventTracker from './event-tracker';
import { intialiseContractRequirements } from './lib/contracts';
import { normaliseLegacyDatabase } from './lib/migration';
import * as osRelease from './lib/os-release';
import Logger from './logger';
import SupervisorAPI from './supervisor-api';

import constants = require('./lib/constants');
import log from './lib/supervisor-console';
import version = require('./lib/supervisor-version');

const startupConfigFields: ConfigKey[] = [
	'uuid',
	'listenPort',
	'apiEndpoint',
	'apiSecret',
	'apiTimeout',
	'unmanaged',
	'deviceApiKey',
	'mixpanelToken',
	'mixpanelHost',
	'loggingEnabled',
	'localMode',
	'legacyAppsPresent',
];

export class Supervisor {
	private config: Config;
	private eventTracker: EventTracker;
	private logger: Logger;
	private deviceState: DeviceState;
	private apiBinder: APIBinder;
	private api: SupervisorAPI;

	public constructor() {
		this.config = new Config();
		this.eventTracker = new EventTracker();
		this.logger = new Logger({ eventTracker: this.eventTracker });
		this.apiBinder = new APIBinder({
			config: this.config,
			eventTracker: this.eventTracker,
			logger: this.logger,
		});
		this.deviceState = new DeviceState({
			config: this.config,
			eventTracker: this.eventTracker,
			logger: this.logger,
			apiBinder: this.apiBinder,
		});
		// workaround the circular dependency
		this.apiBinder.setDeviceState(this.deviceState);

		// FIXME: rearchitect proxyvisor to avoid this circular dependency
		// by storing current state and having the APIBinder query and report it / provision devices
		this.deviceState.applications.proxyvisor.bindToAPI(this.apiBinder);

		this.api = new SupervisorAPI({
			config: this.config,
			eventTracker: this.eventTracker,
			routers: [this.apiBinder.router, this.deviceState.router],
			healthchecks: [
				this.apiBinder.healthcheck.bind(this.apiBinder),
				this.deviceState.healthcheck.bind(this.deviceState),
			],
		});
	}

	public async init() {
		log.info(`Supervisor v${version} starting up...`);

		await db.initialized;
		await this.config.init();

		const conf = await this.config.getMany(startupConfigFields);

		// We can't print to the dashboard until the logger
		// has started up, so we leave a trail of breadcrumbs
		// in the logs in case runtime fails to get to the
		// first dashboard logs
		log.debug('Starting event tracker');
		await this.eventTracker.init(conf);

		log.debug('Starting logging infrastructure');
		this.logger.init({
			enableLogs: conf.loggingEnabled,
			config: this.config,
			...conf,
		});

		intialiseContractRequirements({
			supervisorVersion: version,
			deviceType: await this.config.get('deviceType'),
			l4tVersion: await osRelease.getL4tVersion(),
		});

		log.debug('Starting api binder');
		await this.apiBinder.initClient();

		this.logger.logSystemMessage('Supervisor starting', {}, 'Supervisor start');
		if (conf.legacyAppsPresent && this.apiBinder.balenaApi != null) {
			log.info('Legacy app detected, running migration');
			await normaliseLegacyDatabase(
				this.deviceState.config,
				this.deviceState.applications,
				this.apiBinder.balenaApi,
			);
		}

		await this.deviceState.init();

		log.info('Starting API server');
		this.api.listen(
			constants.allowedInterfaces,
			conf.listenPort,
			conf.apiTimeout,
		);
		this.deviceState.on('shutdown', () => this.api.stop());

		await this.apiBinder.start();
	}
}

export default Supervisor;
