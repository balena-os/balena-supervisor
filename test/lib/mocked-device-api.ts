import { Router } from 'express';
import { fs } from 'mz';

import { ApplicationManager } from '../../src/application-manager';
import Config from '../../src/config';
import Database from '../../src/db';
import { createV1Api } from '../../src/device-api/v1';
import { createV2Api } from '../../src/device-api/v2';
import DeviceState from '../../src/device-state';
import EventTracker from '../../src/event-tracker';
import SupervisorAPI from '../../src/supervisor-api';

const DB_PATH = './test/data/supervisor-api.sqlite';
const DEFAULT_SECRET = 'secure_api_secret';

async function create(): Promise<SupervisorAPI> {
	// Get SupervisorAPI construct options
	const { db, config, eventTracker, deviceState } = await createAPIOpts();
	// Create ApplicationManager
	const appManager = new ApplicationManager({
		db,
		config,
		eventTracker,
		logger: null,
		deviceState,
		apiBinder: null,
	});
	// Create SupervisorAPI
	const api = new SupervisorAPI({
		config,
		eventTracker,
		routers: [buildRoutes(appManager)],
		healthchecks: [],
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
}

async function createAPIOpts(): Promise<SupervisorAPIOpts> {
	// Create database
	const db = new Database({
		databasePath: DB_PATH,
	});
	await db.init();
	// Create config
	const mockedConfig = new Config({ db });
	// Set testing secret
	await mockedConfig.set({
		apiSecret: DEFAULT_SECRET,
	});
	await mockedConfig.init();
	// Create EventTracker
	const tracker = new EventTracker();
	// Create deviceState
	const deviceState = new DeviceState({
		db,
		config: mockedConfig,
		eventTracker: tracker,
		logger: null as any,
		apiBinder: null as any,
	});
	return {
		db,
		config: mockedConfig,
		eventTracker: tracker,
		deviceState,
	};
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

interface SupervisorAPIOpts {
	db: Database;
	config: Config;
	eventTracker: EventTracker;
	deviceState: DeviceState;
}

export = { create, cleanUp, DEFAULT_SECRET };
