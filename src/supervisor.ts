import * as apiBinder from './api-binder';
import * as db from './db';
import * as config from './config';
import * as deviceState from './device-state';
import * as tags from './api-binder/tags';
import * as logger from './logging';
import SupervisorAPI from './device-api';
import * as v1 from './device-api/v1';
import * as v2 from './device-api/v2';
import logMonitor from './logging/monitor';

import { initializeContractRequirements } from './lib/contracts';
import { normaliseLegacyDatabase } from './lib/legacy';
import * as osRelease from './lib/os-release';
import log from './lib/supervisor-console';
import version from './lib/supervisor-version';
import * as avahi from './lib/avahi';
import * as firewall from './lib/firewall';
import * as constants from './lib/constants';
import * as uname from './lib/uname';
import * as servicesManager from './compose/service-manager';
import * as supervisorMetadata from './lib/supervisor-metadata';

const startupConfigFields: config.ConfigKey[] = [
	'uuid',
	'listenPort',
	'listenPortOverride',
	'apiEndpoint',
	'apiTimeout',
	'unmanaged',
	'deviceApiKey',
	'loggingEnabled',
	'localMode',
	'legacyAppsPresent',
];

async function recoverFromOrphanedApiEndpointOverride() {
	const { apiEndpointOverride, listenPort, listenPortOverride } =
		await config.getMany([
			'apiEndpointOverride',
			'listenPort',
			'listenPortOverride',
		]);

	// Helios takeover moves the legacy API to listenPortOverride and proxies the
	// original loopback endpoint through the service-relay sidecar. Preserve all
	// other endpoint overrides, as they may be deliberately configured proxies.
	if (
		listenPortOverride == null ||
		apiEndpointOverride !== `http://127.0.0.1:${listenPort}`
	) {
		return;
	}

	let relayRunning: boolean;
	try {
		relayRunning = (
			await servicesManager.getAll('service-name=service-relay')
		).some(
			(service) =>
				service.appUuid != null &&
				supervisorMetadata.isSupervisorApp(service.appUuid) &&
				service.status === 'Running',
		);
	} catch (error) {
		log.warn(
			'Could not determine service-relay status; preserving API endpoint override',
			error,
		);
		return;
	}
	if (relayRunning) {
		return;
	}

	log.warn(
		'Removing API endpoint override because service-relay is not running',
	);
	await db.models('config').where({ key: 'apiEndpointOverride' }).delete();
}

export class Supervisor {
	private api: SupervisorAPI;

	public async init() {
		log.info(`Supervisor v${version} starting up...`);

		await db.initialized();
		await config.initialized();
		await recoverFromOrphanedApiEndpointOverride();
		await avahi.initialized();
		log.debug('Starting logging infrastructure');
		await logger.initialized();

		const conf = await config.getMany(startupConfigFields);

		// These could fail, but if so, the device has much bigger problems
		const [unameR, unameS] = await Promise.all([
			uname.get('-r'),
			uname.get('-s'),
		]);
		initializeContractRequirements({
			supervisorVersion: version,
			deviceType: await config.get('deviceType'),
			deviceArch: await config.get('deviceArch'),
			kernelVersion: uname.parseKernelVersion(unameR),
			kernelSlug: uname.parseKernelSlug(unameS),
			osVersion: await osRelease.getOSSemver(constants.hostOSVersionPath),
			osSlug: await osRelease.getOSSlug(constants.hostOSVersionPath),
			l4tVersion: uname.parseL4tVersion(unameR),
		});

		log.info('Starting firewall');
		await firewall.initialised();

		log.debug('Starting api binder');
		await apiBinder.initialized();

		await deviceState.initialized();
		await tags.initialized();

		const unmanaged = await config.get('unmanaged');
		logger.logSystemMessage('Supervisor starting', {}, 'Supervisor start');
		if (conf.legacyAppsPresent && !unmanaged) {
			log.info('Legacy app detected, running migration');
			await normaliseLegacyDatabase();
		}

		// Listen on the override port if set
		const listenPort = conf.listenPortOverride ?? conf.listenPort;
		const listenAddr = conf.listenPortOverride
			? constants.supervisorNetworkGateway
			: undefined;

		// Start the state engine, the device API and API binder in parallel
		await Promise.all([
			deviceState.loadInitialState(),
			(() => {
				log.info('Starting API server');
				this.api = new SupervisorAPI({
					routers: [v1.router, v2.router],
					healthchecks: [apiBinder.healthcheck, deviceState.healthcheck],
				});
				deviceState.on('shutdown', () => this.api.stop());
				return this.api.listen(listenPort, conf.apiTimeout, listenAddr);
			})(),
			apiBinder.start(),
		]);

		await logMonitor.start();
	}
}

export default Supervisor;
