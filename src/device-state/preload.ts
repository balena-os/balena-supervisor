import _ from 'lodash';
import { promises as fs } from 'fs';

import type { Image } from '../compose/images';
import { imageFromService } from '../compose/images';
import { NumericIdentifier } from '../types';
import * as deviceState from '../device-state';
import * as config from '../config';
import * as deviceConfig from '../device-config';
import * as eventTracker from '../event-tracker';
import * as imageManager from '../compose/images';

import {
	AppsJsonParseError,
	isEISDIR,
	isENOENT,
	InternalInconsistencyError,
} from '../lib/errors';
import log from '../lib/supervisor-console';

import { fromLegacyAppsJson, fromV2AppsJson } from './legacy';
import { AppsJsonFormat } from '../types/state';
import * as fsUtils from '../lib/fs-utils';
import { isLeft } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

export function appsJsonBackup(appsPath: string) {
	return `${appsPath}.preloaded`;
}

async function migrateAppsJson(appsPath: string) {
	const targetPath = appsJsonBackup(appsPath);
	if (!(await fsUtils.exists(targetPath))) {
		// Try to rename the path so the preload target state won't
		// be used again if the database gets deleted for any reason.
		// If the target file already exists or something fails, just debug
		// the failure.
		await fsUtils
			.safeRename(appsPath, targetPath)
			.then(() => fsUtils.writeFileAtomic(appsPath, '{}'))
			.then(() => log.debug(`Migrated existing apps.json`))
			.catch((e) =>
				log.debug(
					`Continuing without migrating apps.json because of`,
					e.message,
				),
			);
	}
}

export async function loadTargetFromFile(appsPath: string): Promise<boolean> {
	log.info('Attempting to load any preloaded applications');
	try {
		const content = await fs.readFile(appsPath, 'utf8');

		// It's either a target state or it's a list of legacy
		// style application definitions, we reconcile this below
		let stateFromFile: AppsJsonFormat | any[];
		try {
			stateFromFile = JSON.parse(content);
		} catch (e: any) {
			throw new AppsJsonParseError(e);
		}

		if (Array.isArray(stateFromFile)) {
			log.debug('Detected a legacy apps.json, converting...');
			stateFromFile = fromLegacyAppsJson(stateFromFile as any[]);
		}

		// if apps.json apps are keyed by numeric ids, then convert to v3 target state
		if (Object.keys(stateFromFile.apps || {}).some(NumericIdentifier.is)) {
			stateFromFile = await fromV2AppsJson(stateFromFile as any);
		}

		// Check that transformed apps.json has the correct format
		const decodedAppsJson = AppsJsonFormat.decode(stateFromFile);
		if (isLeft(decodedAppsJson)) {
			throw new AppsJsonParseError(
				['Invalid apps.json.']
					.concat(Reporter.report(decodedAppsJson))
					.join('\n'),
			);
		}

		// If decoding apps.json succeeded then preloadState will have the right format
		const preloadState = decodedAppsJson.right;

		if (_.isEmpty(preloadState.config) && _.isEmpty(preloadState.apps)) {
			return false;
		}

		const uuid = await config.get('uuid');

		if (!uuid) {
			throw new InternalInconsistencyError(
				`No uuid found for the local device`,
			);
		}

		const imgs: Image[] = Object.keys(preloadState.apps)
			.map((appUuid) => {
				const app = preloadState.apps[appUuid];
				const [releaseUuid] = Object.keys(app.releases);
				const release = app.releases[releaseUuid] ?? {};
				const services = release?.services ?? {};
				return Object.keys(services).map((serviceName) => {
					const service = services[serviceName];
					const svc = {
						imageName: service.image,
						serviceName,
						imageId: service.image_id,
						serviceId: service.id,
						releaseId: release.id,
						commit: releaseUuid,
						appId: app.id,
						appUuid,
					};
					return imageFromService(svc);
				});
			})
			.flat();

		for (const image of imgs) {
			const name = imageManager.normalise(image.name);
			image.name = name;
			await imageManager.save(image);
		}

		const deviceConf = await deviceConfig.getCurrent();
		const formattedConf = deviceConfig.formatConfigKeys(preloadState.config);
		const localState = {
			[uuid]: {
				name: '',
				config: { ...deviceConf, ...formattedConf },
				apps: preloadState.apps,
			},
		};

		await deviceState.setTarget(localState);
		await migrateAppsJson(appsPath);
		log.success('Preloading complete');
		if (preloadState.pinDevice) {
			// Multi-app warning!
			// The following will need to be changed once running
			// multiple applications is possible.
			// For now, just select the first app with 'fleet' class (there can be only one)
			const [appToPin] = Object.values(preloadState.apps).filter(
				(app) => app.class === 'fleet',
			);
			const [commitToPin] = Object.keys(appToPin?.releases ?? {});
			if (commitToPin != null && appToPin != null) {
				await config.set({
					pinDevice: {
						commit: commitToPin,
						app: appToPin.id,
					},
				});
			}
		}
		return true;
	} catch (e: any) {
		// Ensure that this is actually a file, and not an empty path
		// It can be an empty path because if the file does not exist
		// on host, the docker daemon creates an empty directory when
		// the bind mount is added
		if (isENOENT(e) || isEISDIR(e)) {
			log.debug('No apps.json file present, skipping preload');
		} else {
			log.debug(e.message);
			eventTracker.track('Loading preloaded apps failed', {
				error: e,
			});
		}
	}
	return false;
}
