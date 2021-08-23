import * as _ from 'lodash';

import * as path from 'path';
import * as apiBinder from '../api-binder';
import * as config from '../config';
import * as db from '../db';
import * as volumeManager from '../compose/volume-manager';
import * as serviceManager from '../compose/service-manager';
import * as deviceState from '../device-state';
import * as applicationManager from '../compose/application-manager';
import {
	StatusError,
	DatabaseParseError,
	NotFoundError,
	InternalInconsistencyError,
} from '../lib/errors';
import * as constants from '../lib/constants';
import { docker } from '../lib/docker-utils';
import { log } from '../lib/supervisor-console';
import Volume from '../compose/volume';
import * as logger from '../logger';
import type {
	DatabaseApp,
	DatabaseService,
} from '../device-state/target-state-cache';

import { TargetApp, TargetApps, TargetState } from '../types';

const defaultLegacyVolume = () => 'resin-data';

/**
 * Creates a docker volume from the legacy data directory
 */
export async function createVolumeFromLegacyData(
	appId: number,
): Promise<Volume | void> {
	const name = defaultLegacyVolume();
	const legacyPath = path.join(
		constants.rootMountPoint,
		'mnt/data/resin-data',
		appId.toString(),
	);

	try {
		return await volumeManager.createFromPath({ name, appId }, {}, legacyPath);
	} catch (e) {
		logger.logSystemMessage(
			`Warning: could not migrate legacy /data volume: ${e.message}`,
			{ error: e },
			'Volume migration error',
		);
	}
}

/**
 * Gets proper database ids from the cloud for the app and app services
 */
export async function normaliseLegacyDatabase() {
	await apiBinder.initialized;
	await deviceState.initialized;

	if (apiBinder.balenaApi == null) {
		throw new InternalInconsistencyError(
			'API binder is not initialized correctly',
		);
	}

	// When legacy apps are present, we kill their containers and migrate their /data to a named volume
	log.info('Migrating ids for legacy app...');

	const apps: DatabaseApp[] = await db.models('app').select();

	if (apps.length === 0) {
		log.debug('No app to migrate');
		return;
	}

	for (const app of apps) {
		let services: DatabaseService[];

		try {
			services = JSON.parse(app.services);
		} catch (e) {
			throw new DatabaseParseError(e);
		}

		// Check there's a main service, with legacy-container set
		if (services.length !== 1) {
			log.debug("App doesn't have a single service, ignoring");
			return;
		}

		const service = services[0];
		if (
			!service.labels['io.resin.legacy-container'] &&
			!service.labels['io.balena.legacy-container']
		) {
			log.debug('Service is not marked as legacy, ignoring');
			return;
		}

		log.debug(`Getting release ${app.commit} for app ${app.appId} from API`);
		const releases = await apiBinder.balenaApi.get({
			resource: 'release',
			options: {
				$filter: {
					belongs_to__application: app.appId,
					commit: app.commit,
					status: 'success',
				},
				$expand: {
					contains__image: {
						$expand: 'image',
					},
					belongs_to__application: {
						$select: ['uuid'],
					},
				},
			},
		});

		if (releases.length === 0) {
			log.warn(
				`No compatible releases found in API, removing ${app.appId} from target state`,
			);
			await db.models('app').where({ appId: app.appId }).del();
		}

		// We need to get the app.uuid, release.id, serviceId, image.id and updated imageUrl
		const release = releases[0];
		const uuid = release.belongs_to__application[0].uuid;
		const image = release.contains__image[0].image[0];
		const serviceId = image.is_a_build_of__service.__id;
		const imageUrl = !image.content_hash
			? image.is_stored_at__image_location
			: `${image.is_stored_at__image_location}@${image.content_hash}`;

		log.debug(
			`Found a release with releaseId ${release.id}, imageId ${image.id}, serviceId ${serviceId}\nImage location is ${imageUrl}`,
		);

		const imageFromDocker = await docker
			.getImage(service.image)
			.inspect()
			.catch((error) => {
				if (error instanceof NotFoundError) {
					return;
				}

				throw error;
			});
		const imagesFromDatabase = await db
			.models('image')
			.where({ name: service.image })
			.select();

		await db.transaction(async (trx: db.Transaction) => {
			try {
				if (imagesFromDatabase.length > 0) {
					log.debug('Deleting existing image entry in db');
					await trx('image').where({ name: service.image }).del();
				} else {
					log.debug('No image in db to delete');
				}
			} finally {
				if (imageFromDocker != null) {
					log.debug('Inserting fixed image entry in db');
					await trx('image').insert({
						name: imageUrl,
						appId: app.appId,
						appUuid: uuid,
						serviceId,
						serviceName: service.serviceName,
						imageId: image.id,
						releaseId: release.id,
						commit: app.commit,
						dependent: 0,
						dockerImageId: imageFromDocker.Id,
					});
				} else {
					log.debug('Image is not downloaded, so not saving it to db');
				}

				delete service.labels['io.resin.legacy-container'];
				delete service.labels['io.balena.legacy-container'];

				Object.assign(app, {
					services: JSON.stringify([
						Object.assign(service, {
							appId: app.appId,
							appUuid: uuid,
							image: imageUrl,
							serviceId,
							imageId: image.id,
							releaseId: release.id,
							commit: app.commit,
						}),
					]),
					uuid,
					releaseId: release.id,
					class: 'fleet',
				});

				log.debug('Updating app entry in db');
				log.success('Successfully migrated legacy application');
				await trx('app').update(app).where({ appId: app.appId });
			}
		});
	}

	log.debug('Killing legacy containers');
	await serviceManager.killAllLegacy();
	log.debug('Migrating legacy app volumes');

	await applicationManager.initialized;
	const targetApps = await applicationManager.getTargetApps();

	for (const app of Object.values(targetApps)) {
		await createVolumeFromLegacyData(app.id);
	}

	await config.set({
		legacyAppsPresent: false,
	});
}

export type TargetAppsV2 = {
	[id: string]: {
		name: string;
		commit?: string;
		releaseId?: number;
		services: { [id: string]: any };
		volumes: { [name: string]: any };
		networks: { [name: string]: any };
	};
};

type TargetStateV2 = {
	local: {
		name: string;
		config: { [name: string]: string };
		apps: TargetAppsV2;
	};
};

export async function fromV2TargetState(
	target: TargetStateV2,
	local = false,
): Promise<TargetState> {
	const { uuid, name } = await config.getMany(['uuid', 'name']);
	if (!uuid) {
		throw new InternalInconsistencyError('No UUID for device');
	}

	return {
		[uuid]: {
			name: target?.local?.name ?? name,
			config: target?.local?.config ?? {},
			apps: await fromV2TargetApps(target?.local?.apps ?? {}, local),
		},
	};
}

/**
 * Convert v2 to v3 target apps. If local is false
 * it will query the API to get the app uuid
 */
export async function fromV2TargetApps(
	apps: TargetAppsV2,
	local = false,
): Promise<TargetApps> {
	await apiBinder.initialized;
	await deviceState.initialized;

	if (apiBinder.balenaApi == null) {
		throw new InternalInconsistencyError(
			'API binder is not initialized correctly',
		);
	}

	const { balenaApi } = apiBinder;
	const getUUIDFromAPI = async (appId: number) => {
		const appDetails = await balenaApi.get({
			resource: 'application',
			id: appId,
			options: {
				$select: ['uuid'],
			},
		});

		if (!appDetails || !appDetails.uuid) {
			throw new StatusError(404, `No app with id ${appId} found on the API.`);
		}

		return appDetails.uuid;
	};

	return (
		(
			await Promise.all(
				Object.keys(apps).map(
					async (id): Promise<[string, TargetApp]> => {
						const appId = parseInt(id, 10);
						const app = apps[appId];

						// If local mode just use id as uuid
						const uuid = local ? id : await getUUIDFromAPI(appId);

						const releases = app.commit
							? {
									[app.commit]: {
										id: app.releaseId,
										services: Object.keys(app.services ?? {})
											.map((serviceId) => {
												const {
													imageId,
													serviceName,
													image,
													environment,
													labels,
													running,
													serviceId: _serviceId,
													contract,
													...composition
												} = app.services[serviceId];

												return [
													serviceName,
													{
														id: serviceId,
														image_id: imageId,
														image,
														environment,
														labels,
														running,
														contract,
														composition,
													},
												];
											})
											.reduce(
												(res, [serviceName, svc]) => ({
													...res,
													[serviceName]: svc,
												}),
												{},
											),
										volumes: app.volumes ?? {},
										networks: app.networks ?? {},
									},
							  }
							: {};

						return [
							uuid,
							{
								id: appId,
								name: app.name,
								class: 'fleet',
								releases,
							} as TargetApp,
						];
					},
				),
			)
		)
			// Key by uuid
			.reduce((res, [uuid, app]) => ({ ...res, [uuid]: app }), {})
	);
}
