import * as _ from 'lodash';
import { PinejsClientRequest } from 'pinejs-client-request';

import ApplicationManager from '../application-manager';
import Config from '../config';
import Database, { Transaction } from '../db';
import { DatabaseParseError, NotFoundError } from '../lib/errors';
import { log } from '../lib/supervisor-console';
import {
	ApplicationDatabaseFormat,
	AppsJsonFormat,
	TargetApplication,
} from '../types/state';

export const defaultLegacyVolume = () => 'resin-data';

export function singleToMulticontainerApp(
	app: Dictionary<any>,
): TargetApplication & { appId: string } {
	const environment: Dictionary<string> = {};
	for (const key in app.env) {
		if (!/^RESIN_/.test(key)) {
			environment[key] = app.env[key];
		}
	}

	const { appId } = app;
	const conf = app.config != null ? app.config : {};
	const newApp: TargetApplication & { appId: string } = {
		appId: appId.toString(),
		commit: app.commit,
		name: app.name,
		releaseId: 1,
		networks: {},
		volumes: {},
		services: {},
	};
	const defaultVolume = exports.defaultLegacyVolume();
	newApp.volumes[defaultVolume] = {};
	const updateStrategy =
		conf['RESIN_SUPERVISOR_UPDATE_STRATEGY'] != null
			? conf['RESIN_SUPERVISOR_UPDATE_STRATEGY']
			: 'download-then-kill';
	const handoverTimeout =
		conf['RESIN_SUPERVISOR_HANDOVER_TIMEOUT'] != null
			? conf['RESIN_SUPERVISOR_HANDOVER_TIMEOUT']
			: '';
	const restartPolicy =
		conf['RESIN_APP_RESTART_POLICY'] != null
			? conf['RESIN_APP_RESTART_POLICY']
			: 'always';
	newApp.services = {
		// Disable the next line, as this *has* to be a string
		// tslint:disable-next-line
		'1': {
			appId,
			serviceName: 'main',
			imageId: 1,
			commit: app.commit,
			releaseId: 1,
			image: app.imageId,
			privileged: true,
			networkMode: 'host',
			volumes: [`${defaultVolume}:/data`],
			labels: {
				'io.resin.features.kernel-modules': '1',
				'io.resin.features.firmware': '1',
				'io.resin.features.dbus': '1',
				'io.resin.features.supervisor-api': '1',
				'io.resin.features.resin-api': '1',
				'io.resin.update.strategy': updateStrategy,
				'io.resin.update.handover-timeout': handoverTimeout,
				'io.resin.legacy-container': '1',
			},
			environment,
			restart: restartPolicy,
			running: true,
		},
	};
	return newApp;
}

export function convertLegacyAppsJson(appsArray: any[]): AppsJsonFormat {
	const deviceConfig = _.reduce(
		appsArray,
		(conf, app) => {
			return _.merge({}, conf, app.config);
		},
		{},
	);

	const apps = _.keyBy(_.map(appsArray, singleToMulticontainerApp), 'appId');
	return { apps, config: deviceConfig } as AppsJsonFormat;
}

export async function normaliseLegacyDatabase(
	config: Config,
	application: ApplicationManager,
	db: Database,
	balenaApi: PinejsClientRequest,
) {
	// When legacy apps are present, we kill their containers and migrate their /data to a named volume
	log.info('Migrating ids for legacy app...');

	const apps: ApplicationDatabaseFormat = await db.models('app').select();

	if (apps.length === 0) {
		log.debug('No app to migrate');
		return;
	}

	for (const app of apps) {
		let services: Array<TargetApplication['services']['']>;

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
		const releases = (await balenaApi.get({
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
				},
			},
		})) as Array<Dictionary<any>>;

		if (releases.length === 0) {
			log.warn(
				`No compatible releases found in API, removing ${
					app.appId
				} from target state`,
			);
			await db
				.models('app')
				.where({ appId: app.appId })
				.del();
		}

		// We need to get the release.id, serviceId, image.id and updated imageUrl
		const release = releases[0];
		const image = release.contains__image[0].image[0];
		const serviceId = image.is_a_build_of__service.__id;
		const imageUrl = !image.content_hash
			? image.is_stored_at__image_location
			: `${image.is_stored_at__image_location}@${image.content_hash}`;

		log.debug(
			`Found a release with releaseId ${release.id}, imageId ${
				image.id
			}, serviceId ${serviceId}\nImage location is ${imageUrl}`,
		);

		const imageFromDocker = await application.docker
			.getImage(service.image)
			.inspect()
			.catch(e => {
				if (e instanceof NotFoundError) {
					return;
				}

				throw e;
			});
		const imagesFromDatabase = await db
			.models('image')
			.where({ name: service.image })
			.select();

		await db.transaction(async (trx: Transaction) => {
			try {
				if (imagesFromDatabase.length > 0) {
					log.debug('Deleting existing image entry in db');
					await trx('image')
						.where({ name: service.image })
						.del();
				} else {
					log.debug('No image in db to delete');
				}
			} finally {
				if (imageFromDocker != null) {
					log.debug('Inserting fixed image entry in db');
					await trx('image').insert({
						name: imageUrl,
						appId: app.appId,
						serviceId,
						serviceName: service.serviceName,
						imageId: image.id,
						releaseId: release.id,
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
							image: imageUrl,
							serviceID: serviceId,
							imageId: image.id,
							releaseId: release.id,
						}),
					]),
					releaseId: release.id,
				});

				log.debug('Updating app entry in db');
				log.success('Successfully migrated legacy application');
				await trx('app')
					.update(app)
					.where({ appId: app.appId });
			}
		});
	}

	log.debug('Killing legacy containers');
	await application.services.killAllLegacy();
	log.debug('Migrating legacy app volumes');

	const targetApps = await application.getTargetApps();

	for (const appId of _.keys(targetApps)) {
		await application.volumes.createFromLegacy(parseInt(appId, 10));
	}

	await config.set({
		legacyAppsPresent: false,
	});
}
