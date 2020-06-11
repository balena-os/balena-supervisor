import { promises as fs } from 'fs';
import * as path from 'path';
import * as _ from 'lodash';
import type { ImageInspectInfo } from 'dockerode';

import * as config from '../config';
import * as db from '../db';
import * as targetStateCache from '../device-state/target-state-cache';
import constants = require('../lib/constants');
import { pathExistsOnHost } from '../lib/fs-utils';
import * as dockerUtils from '../lib/docker-utils';
import { NotFoundError } from '../lib/errors';

import Service from '../compose/service';
import Network from '../compose/network';
import Volume from '../compose/volume';
import type {
	DeviceMetadata,
	ServiceComposeConfig,
} from '../compose/types/service';
import * as images from '../compose/images';

import { InstancedAppState, TargetApplication } from '../types/state';
import { checkInt } from '../lib/validation';

type InstancedApp = InstancedAppState[0];

// Fetch and instance an app from the db. Throws if the requested appId cannot be found.
// Currently this function does quite a bit more than it needs to as it pulls in a bunch
// of required information for the instances but we should think about a method of not
// requiring that data here
export async function getApp(id: number): Promise<InstancedApp> {
	const dbApp = await getDBEntry(id);
	return await buildApp(dbApp);
}

export async function getApps(): Promise<InstancedAppState> {
	const dbApps = await getDBEntry();
	const apps: InstancedAppState = {};
	for (const app of dbApps) {
		apps[app.appId] = await buildApp(app);
	}
	return apps;
}

async function buildApp(dbApp: targetStateCache.DatabaseApp) {
	const volumes = _.mapValues(JSON.parse(dbApp.volumes) ?? {}, (conf, name) => {
		if (conf == null) {
			conf = {};
		}
		if (conf.labels == null) {
			conf.labels = {};
		}
		return Volume.fromComposeObject(name, dbApp.appId, conf);
	});

	const networks = _.mapValues(
		JSON.parse(dbApp.networks) ?? {},
		(conf, name) => {
			if (conf == null) {
				conf = {};
			}
			return Network.fromComposeObject(name, dbApp.appId, conf);
		},
	);

	const opts = await config.get('extendedEnvOptions');
	const supervisorApiHost = dockerUtils
		.getNetworkGateway(constants.supervisorNetworkInterface)
		.catch(() => '127.0.0.1');
	const hostPathExists = {
		firmware: await pathExistsOnHost('/lib/firmware'),
		modules: await pathExistsOnHost('/lib/modules'),
	};
	const hostnameOnHost = _.trim(
		await fs.readFile(
			path.join(constants.rootMountPoint, '/etc/hostname'),
			'utf8',
		),
	);

	const svcOpts = {
		appName: dbApp.name,
		supervisorApiHost,
		hostPathExists,
		hostnameOnHost,
		...opts,
	};

	// In the db, the services are an array, but here we switch them to an
	// object so that they are consistent
	const services = _.keyBy(
		await Promise.all(
			(JSON.parse(dbApp.services) ?? []).map(
				async (svc: ServiceComposeConfig) => {
					// Try to fill the image id if the image is downloaded
					let imageInfo: ImageInspectInfo | undefined;
					try {
						imageInfo = await images.inspectByName(svc.image);
					} catch (e) {
						if (NotFoundError(e)) {
							imageInfo = undefined;
						} else {
							throw e;
						}
					}

					const thisSvcOpts = {
						...svcOpts,
						imageInfo,
						serviceName: svc.serviceName,
					};
					// We force the casting here as we know that the UUID exists, but the typings do
					// not
					return Service.fromComposeObject(
						svc,
						(thisSvcOpts as unknown) as DeviceMetadata,
					);
				},
			),
		),
		'serviceId',
	) as Dictionary<Service>;

	return {
		appId: dbApp.appId,
		commit: dbApp.commit,
		releaseId: dbApp.releaseId,
		name: dbApp.name,
		source: dbApp.source,

		services,
		volumes,
		networks,
	};
}

export async function setApps(
	apps: { [appId: number]: TargetApplication },
	source: string,
	trx?: db.Transaction,
) {
	const cloned = _.cloneDeep(apps);

	const dbApps = await Promise.all(
		Object.keys(cloned).map(async (appIdStr) => {
			const appId = checkInt(appIdStr)!;

			const app = cloned[appId];
			const services = await Promise.all(
				_.map(app.services, async (s, sId) => ({
					...s,
					appId,
					releaseId: app.releaseId,
					serviceId: checkInt(sId),
					commit: app.commit,
					image: await images.normalise(s.image),
				})),
			);

			return {
				appId,
				source,
				commit: app.commit,
				name: app.name,
				releaseId: app.releaseId,
				services: JSON.stringify(services),
				networks: JSON.stringify(app.networks ?? {}),
				volumes: JSON.stringify(app.volumes ?? {}),
			};
		}),
	);
	await targetStateCache.setTargetApps(dbApps, trx);
}

function getDBEntry(): Promise<targetStateCache.DatabaseApp[]>;
function getDBEntry(appId: number): Promise<targetStateCache.DatabaseApp>;
async function getDBEntry(appId?: number) {
	await config.initialized;
	await targetStateCache.initialized;

	return appId != null
		? targetStateCache.getTargetApp(appId)
		: targetStateCache.getTargetApps();
}
