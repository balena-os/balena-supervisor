import { Router } from 'express';
import { fs } from 'mz';
import { stub } from 'sinon';

import { ApplicationManager } from '../../src/application-manager';
import Config from '../../src/config';
import * as db from '../../src/db';
import { createV1Api } from '../../src/device-api/v1';
import { createV2Api } from '../../src/device-api/v2';
import APIBinder from '../../src/api-binder';
import DeviceState from '../../src/device-state';
import EventTracker from '../../src/event-tracker';
import SupervisorAPI from '../../src/supervisor-api';

import { Images } from '../../src/compose/images';
import { ServiceManager } from '../../src/compose/service-manager';
import { NetworkManager } from '../../src/compose/network-manager';
import { VolumeManager } from '../../src/compose/volume-manager';
import * as apiSecrets from '../../src/lib/api-secrets';
import _ = require('lodash');

const DB_PATH = './test/data/supervisor-api.sqlite';
// Holds all values used for stubbing
const STUBBED_VALUES = {
	config: {
		currentCommit: '7fc9c5bea8e361acd49886fe6cc1e1cd',
	},
	services: [
		{
			appId: 1,
			imageId: 1111,
			serviceId: 1,
			status: 'Running',
			releaseId: 99999,
			createdAt: new Date('2020-04-25T04:15:23.111Z'),
			serviceName: 'main',
		},
		{
			appId: 1,
			imageId: 2222,
			serviceId: 2,
			status: 'Running',
			releaseId: 99999,
			createdAt: new Date('2020-04-25T04:15:23.111Z'),
			serviceName: 'redis',
		},
		{
			appId: 2,
			serviceId: 3,
			imageId: 3333,
			status: 'Running',
			releaseId: 77777,
			createdAt: new Date('2020-05-15T19:33:06.088Z'),
			serviceName: 'main',
		},
	],
	images: [],
	networks: [],
	volumes: [],
};

const logger = {
	logSystemMessage: _.noop,
};
/**
 * THIS MOCKED API CONTAINS STUBS THAT MIGHT CAUSE UNEXPECTED RESULTS
 * IF YOU WANT TO ADD/MODIFY STUBS THAT INVOLVE API OPERATIONS
 * AND MULTIPLE TEST CASES WILL USE THEM THEN ADD THEM HERE
 * OTHERWISE YOU CAN ADD STUBS ON A PER TEST CASE BASIS
 *
 * EXAMPLE: We stub ApplicationManager so there is atleast 1 running app
 *
 * You can see all the stubbed values convientiely in STUBBED_VALUES.
 *
 */

async function create(): Promise<SupervisorAPI> {
	// Get SupervisorAPI construct options
	const {
		config,
		eventTracker,
		deviceState,
		apiBinder,
	} = await createAPIOpts();
	// Stub functions
	setupStubs();
	// Create ApplicationManager
	const appManager = new ApplicationManager({
		config,
		eventTracker,
		logger,
		deviceState,
		apiBinder: null,
	});
	// Create SupervisorAPI
	const api = new SupervisorAPI({
		config,
		eventTracker,
		routers: [buildRoutes(appManager)],
		healthchecks: [deviceState.healthcheck, apiBinder.healthcheck],
	});
	// Return SupervisorAPI that is not listening yet
	return api;
}

async function cleanUp(): Promise<void> {
	try {
		// clean up test data
		await fs.unlink(DB_PATH);
	} catch (e) {
		/* noop */
	}
	// Restore created SinonStubs
	return restoreStubs();
}

async function createAPIOpts(): Promise<SupervisorAPIOpts> {
	await db.initialized;
	// Create config
	const mockedConfig = new Config();
	// Initialize and set values for mocked Config
	await initConfig(mockedConfig);
	// Initialise secret keys for the services
	await initSecrets();
	// Create EventTracker
	const tracker = new EventTracker();
	// Create deviceState
	const deviceState = new DeviceState({
		config: mockedConfig,
		eventTracker: tracker,
		logger: null as any,
		apiBinder: null as any,
	});
	const apiBinder = new APIBinder({
		config: mockedConfig,
		eventTracker: tracker,
		logger: null as any,
	});
	return {
		config: mockedConfig,
		eventTracker: tracker,
		deviceState,
		apiBinder,
	};
}

async function initConfig(config: Config): Promise<void> {
	// Set a currentCommit
	await config.set({
		currentCommit: STUBBED_VALUES.config.currentCommit,
	});
	// Initialize this config
	return config.init();
}

async function initSecrets(): Promise<void> {
	// Prefill the keys by simply requesting them
	for (const service of STUBBED_VALUES.services) {
		await apiSecrets.getApiSecretForService(service.appId, service.serviceId, [
			{ type: 'app', appId: service.appId },
		]);
	}
	await apiSecrets.getCloudApiSecret();
}

function buildRoutes(appManager: ApplicationManager): Router {
	// Create new Router
	const router = Router();
	// Add V1 routes
	createV1Api(router, appManager);
	// Add V2 routes
	createV2Api(router, appManager);
	// Return modified Router
	return router;
}

function setupStubs() {
	stub(ServiceManager.prototype, 'getStatus').resolves(STUBBED_VALUES.services);
	stub(Images.prototype, 'getStatus').resolves(STUBBED_VALUES.images);
	stub(NetworkManager.prototype, 'getAllByAppId').resolves(
		STUBBED_VALUES.networks,
	);
	stub(VolumeManager.prototype, 'getAllByAppId').resolves(
		STUBBED_VALUES.volumes,
	);
}

function restoreStubs() {
	(ServiceManager.prototype as any).getStatus.restore();
	(Images.prototype as any).getStatus.restore();
	(NetworkManager.prototype as any).getAllByAppId.restore();
	(VolumeManager.prototype as any).getAllByAppId.restore();
}

interface SupervisorAPIOpts {
	config: Config;
	eventTracker: EventTracker;
	deviceState: DeviceState;
	apiBinder: APIBinder;
}

export = { create, cleanUp, STUBBED_VALUES };
