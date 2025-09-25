import * as _ from 'lodash';
import rewire from 'rewire';

import { unlinkAll } from '~/lib/fs-utils';
import * as serviceManager from '~/src/compose/service-manager';
import * as volumeManager from '~/src/compose/volume-manager';
import * as commitStore from '~/src/compose/commit';
import * as config from '~/src/config';
import * as db from '~/src/db';
import * as v1 from '~/src/device-api/v1';
import * as v2 from '~/src/device-api/v2';
import * as deviceState from '~/src/device-state';
import SupervisorAPI from '~/src/device-api';
import type { Service } from '~/src/compose/service';
import type { Image } from '~/src/compose/images';

const apiBinder = rewire('~/src/api-binder');

const DB_PATH = './test/data/supervisor-api.sqlite';

// Holds all values used for stubbing
const STUBBED_VALUES = {
	commits: {
		1: '7fc9c5bea8e361acd49886fe6cc1e1cd',
		2: '4e380136c2cf56cd64197d51a1ab263a',
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
			containerId: 'abc123',
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

// Useful for creating mock services in the ServiceManager
const mockService = (overrides?: Partial<Service>) => {
	return {
		...{
			appId: 1658654,
			status: 'Running',
			serviceName: 'main',
			imageId: 2885946,
			serviceId: 640681,
			containerId:
				'f93d386599d1b36e71272d46ad69770cff333842db04e2e4c64dda7b54da07c6',
			createdAt: '2020-11-13T20:29:44.143Z',
			config: {
				labels: {},
			},
			toDockerContainer: () => {
				return;
			},
			extraNetworksToJoin: () => {
				return [];
			},
			isEqualConfig: (service: Service) => {
				return _.isEqual(
					_.pick(mockService, ['imageId', 'containerId', 'serviceId']),
					_.pick(service, ['imageId', 'containerId', 'serviceId']),
				);
			},
		},
		...overrides,
	} as Service;
};

// Useful for creating mock images that are returned from Images.getStatus
const mockImage = (overrides?: Partial<Image>) => {
	return {
		...{
			name: 'registry2.balena-cloud.com/v2/e2bf6410ffc30850e96f5071cdd1dca8@sha256:e2e87a8139b8fc14510095b210ad652d7d5badcc64fdc686cbf749d399fba15e',
			appId: 1658654,
			serviceName: 'main',
			imageId: 2885946,
			dockerImageId:
				'sha256:4502983d72e2c72bc292effad1b15b49576da3801356f47fd275ba274d409c1a',
			status: 'Downloaded',
			downloadProgress: null,
		},
		...overrides,
	} as Image;
};

const mockedOptions = {
	listenPort: 54321,
	timeout: 30000,
};

/**
 * THIS MOCKED API CONTAINS STUBS THAT MIGHT CAUSE UNEXPECTED RESULTS
 * IF YOU WANT TO ADD/MODIFY STUBS THAT INVOLVE API OPERATIONS
 * AND MULTIPLE TEST CASES WILL USE THEM THEN ADD THEM HERE
 * OTHERWISE YOU CAN ADD STUBS ON A PER TEST CASE BASIS
 *
 * EXAMPLE: We stub ApplicationManager so there is at least 1 running app
 *
 * You can see all the stubbed values convientiely in STUBBED_VALUES.
 *
 */

async function create(
	healthchecks = [deviceState.healthcheck, apiBinder.healthcheck],
): Promise<SupervisorAPI> {
	// Get SupervisorAPI construct options
	await createAPIOpts();

	// Stub functions
	setupStubs();

	// Create SupervisorAPI
	const api = new SupervisorAPI({
		routers: [v1.router, v2.router],
		healthchecks,
	});

	const macAddress = await config.get('macAddress');
	deviceState.reportCurrentState({
		mac_address: macAddress,
	});

	// Return SupervisorAPI that is not listening yet
	return api;
}

async function cleanUp(): Promise<void> {
	// Clean up test data
	await unlinkAll(DB_PATH);
	// Restore created SinonStubs
	return restoreStubs();
}

async function createAPIOpts(): Promise<void> {
	await db.initialized();
	await deviceState.initialized();

	// Initialize and set values for mocked Config
	await initConfig();
}

async function initConfig(): Promise<void> {
	// Initialize this config
	await config.initialized();

	// Set a currentCommit
	for (const [id, commit] of Object.entries(STUBBED_VALUES.commits)) {
		await commitStore.upsertCommitForApp(parseInt(id, 10), commit);
	}
}

// TO-DO: Create a cleaner way to restore previous values.
const originalVolGetAll = volumeManager.getAllByAppId;
const originalSvcGetStatus = serviceManager.getState;
const originalReadyForUpdates = apiBinder.isReadyForUpdates();

function setupStubs() {
	apiBinder.__set__('readyForUpdates', true);
	// @ts-expect-error Assigning to a RO property
	volumeManager.getAllByAppId = async () => STUBBED_VALUES.volumes;
	// @ts-expect-error Assigning to a RO property
	serviceManager.getState = async () => STUBBED_VALUES.services;
}

function restoreStubs() {
	apiBinder.__set__('readyForUpdates', originalReadyForUpdates);
	// @ts-expect-error Assigning to a RO property
	volumeManager.getAllByAppId = originalVolGetAll;
	// @ts-expect-error Assigning to a RO property
	serviceManager.getState = originalSvcGetStatus;
}

export = {
	create,
	cleanUp,
	STUBBED_VALUES,
	mockService,
	mockImage,
	mockedOptions,
};
