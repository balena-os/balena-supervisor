import type * as db from '../db';
import * as targetStateCache from './target-state-cache';
import type { DatabaseApp, DatabaseService } from './target-state-cache';

import { App } from '../compose/app';
import * as images from '../compose/images';

import type { UUID, TargetApps, TargetRelease, TargetService } from '../types';
import type { InstancedAppState, AppRelease } from '../compose/types';

type InstancedApp = InstancedAppState[0];

// Fetch and instance an app from the db. Throws if the requested appId cannot be found.
// Currently this function does quite a bit more than it needs to as it pulls in a bunch
// of required information for the instances but we should think about a method of not
// requiring that data here
export async function getApp(id: number): Promise<InstancedApp> {
	const dbApp = await getDBEntry(id);
	return await App.fromTargetState(dbApp);
}

export async function getApps(): Promise<InstancedAppState> {
	const dbApps = await getDBEntry();
	const apps: InstancedAppState = {};
	await Promise.all(
		dbApps.map(async (app) => {
			apps[app.appId] = await App.fromTargetState(app);
		}),
	);
	return apps;
}

export async function setApps(
	apps: TargetApps,
	source: string,
	rejectedApps: UUID[] = [],
	trx?: db.Transaction,
) {
	const dbApps = Object.keys(apps).map((uuid) => {
		const { id: appId, ...app } = apps[uuid];
		const rejected = rejectedApps.includes(uuid);

		// Get the first uuid
		const releaseUuid = Object.keys(app.releases).shift();
		const release =
			releaseUuid != null ? app.releases[releaseUuid] : ({} as TargetRelease);

		const services = Object.keys(release.services ?? {}).map((serviceName) => {
			const { id: releaseId } = release;
			const {
				id: serviceId,
				image_id: imageId,
				...service
			} = release.services[serviceName];

			return {
				...service,
				appId,
				appUuid: uuid,
				releaseId,
				commit: releaseUuid,
				imageId,
				serviceId,
				serviceName,
				image: images.normalise(service.image),
			};
		});

		return {
			appId,
			uuid,
			source,
			isHost: !!app.is_host,
			rejected,
			class: app.class,
			name: app.name,
			...(releaseUuid && {
				releaseId: release.id,
				commit: releaseUuid,
			}),
			services: JSON.stringify(services),
			networks: JSON.stringify(release.networks ?? {}),
			volumes: JSON.stringify(release.volumes ?? {}),
		};
	});

	await targetStateCache.setTargetApps(dbApps, trx);
}

/**
 * Create target state from database state
 */
export async function getTargetWithRejections(): Promise<{
	apps: TargetApps;
	rejections: AppRelease[];
}> {
	const dbApps = await getDBEntry();

	const apps: TargetApps = {};
	const rejections: AppRelease[] = [];

	for (const {
		source,
		rejected,
		uuid,
		releaseId,
		commit: releaseUuid,
		...app
	} of dbApps) {
		const services = Object.fromEntries(
			(JSON.parse(app.services) as DatabaseService[]).map(
				({
					serviceName,
					serviceId,
					imageId,
					// Ignore these fields
					appId: _appId,
					appUuid: _appUuid,
					commit: _commit,
					releaseId: _releaseId,
					// Use the remainder of the fields for the service description
					...service
				}) => [
					serviceName,
					{
						id: serviceId,
						image_id: imageId,
						...service,
					} satisfies TargetService,
				],
			),
		);

		const releases =
			releaseUuid && releaseId
				? {
						[releaseUuid]: {
							id: releaseId,
							services,
							networks: JSON.parse(app.networks),
							volumes: JSON.parse(app.volumes),
						} satisfies TargetRelease,
					}
				: {};

		if (rejected && releaseUuid) {
			rejections.push({ appUuid: uuid, releaseUuid });
		}

		apps[uuid] = {
			id: app.appId,
			name: app.name,
			class: app.class,
			is_host: !!app.isHost,
			releases,
		};
	}

	return { apps, rejections };
}

export async function getTargetJson(): Promise<TargetApps> {
	const { apps } = await getTargetWithRejections();
	return apps;
}

function getDBEntry(): Promise<DatabaseApp[]>;
function getDBEntry(appId: number): Promise<DatabaseApp>;
async function getDBEntry(appId?: number) {
	await targetStateCache.initialized();

	return appId != null
		? targetStateCache.getTargetApp(appId)
		: targetStateCache.getTargetApps();
}
