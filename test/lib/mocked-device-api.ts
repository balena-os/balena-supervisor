import { Router } from 'express';
import { fs } from 'mz';

import { ApplicationManager } from '../../src/application-manager';
import * as networkManager from '../../src/compose/network-manager';
import * as serviceManager from '../../src/compose/service-manager';
import * as volumeManager from '../../src/compose/volume-manager';
import * as config from '../../src/config';
import * as db from '../../src/db';
import { createV1Api } from '../../src/device-api/v1';
import { createV2Api } from '../../src/device-api/v2';
import * as apiBinder from '../../src/api-binder';
import * as deviceState from '../../src/device-state';
import SupervisorAPI from '../../src/supervisor-api';

const DB_PATH = './test/data/supervisor-api.sqlite';
// Holds all values used for stubbing
const STUBBED_VALUES = {
	config: {
		apiSecret: 'secure_api_secret',
		currentCommit: '7fc9c5bea8e361acd49886fe6cc1e1cd',
	},
	services: [
		{
			appId: 1,
			imageId: 1111,
			status: 'Running',
			releaseId: 99999,
			createdAt: new Date('2020-04-25T04:15:23.111Z'),
			serviceName: 'main',
		},
		{
			appId: 1,
			imageId: 2222,
			status: 'Running',
			releaseId: 99999,
			createdAt: new Date('2020-04-25T04:15:23.111Z'),
			serviceName: 'redis',
		},
		{
			appId: 2,
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
	await createAPIOpts();

	// Stub functions
	setupStubs();
	// Create ApplicationManager
	const appManager = new ApplicationManager();
	// Create SupervisorAPI
	const api = new SupervisorAPI({
		routers: [deviceState.router, buildRoutes(appManager)],
		healthchecks: [deviceState.healthcheck, apiBinder.healthcheck],
	});

	const macAddress = await config.get('macAddress');
	deviceState.reportCurrentState({
		mac_address: macAddress,
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

async function createAPIOpts(): Promise<void> {
	await db.initialized;
	await deviceState.initialized;

	// Initialize and set values for mocked Config
	await initConfig();
}

async function initConfig(): Promise<void> {
	// Initialize this config
	await config.initialized;
	// Set testing secret
	await config.set({
		apiSecret: STUBBED_VALUES.config.apiSecret,
	});
	// Set a currentCommit
	await config.set({
		currentCommit: STUBBED_VALUES.config.currentCommit,
	});
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

const originalNetGetAll = networkManager.getAllByAppId;
const originalVolGetAll = volumeManager.getAllByAppId;
const originalSvcGetStatus = serviceManager.getStatus;
function setupStubs() {
	// @ts-expect-error Assigning to a RO property
	networkManager.getAllByAppId = async () => STUBBED_VALUES.networks;
	// @ts-expect-error Assigning to a RO property
	volumeManager.getAllByAppId = async () => STUBBED_VALUES.volumes;
	// @ts-expect-error Assigning to a RO property
	serviceManager.getStatus = async () => STUBBED_VALUES.services;
}

function restoreStubs() {
	// @ts-expect-error Assigning to a RO property
	networkManager.getAllByAppId = originalNetGetAll;
	// @ts-expect-error Assigning to a RO property
	volumeManager.getAllByAppId = originalVolGetAll;
	// @ts-expect-error Assigning to a RO property
	serviceManager.getStatus = originalSvcGetStatus;
}

export = { create, cleanUp, STUBBED_VALUES };
