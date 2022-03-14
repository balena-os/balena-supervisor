import * as _ from 'lodash';
import { promises as fs } from 'fs';

import { Image, imageFromService } from '../compose/images';
import * as deviceState from '../device-state';
import * as config from '../config';
import * as deviceConfig from '../device-config';
import * as eventTracker from '../event-tracker';
import * as images from '../compose/images';

import { AppsJsonParseError, EISDIR, ENOENT } from '../lib/errors';
import log from '../lib/supervisor-console';

import { convertLegacyAppsJson } from '../lib/migration';
import { AppsJsonFormat } from '../types/state';
import * as fsUtils from '../lib/fs-utils';

export function appsJsonBackup(appsPath: string) {
	return `${appsPath}.preloaded`;
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
		} catch (e) {
			throw new AppsJsonParseError(e);
		}

		if (_.isArray(stateFromFile)) {
			log.debug('Detected a legacy apps.json, converting...');
			stateFromFile = convertLegacyAppsJson(stateFromFile as any[]);
		}
		const preloadState = stateFromFile as AppsJsonFormat;

		let commitToPin: string | undefined;
		let appToPin: string | undefined;

		if (_.isEmpty(preloadState)) {
			return false;
		}

		const imgs: Image[] = [];
		const appIds = _.keys(preloadState.apps);
		for (const appId of appIds) {
			const app = preloadState.apps[appId];
			// Multi-app warning!
			// The following will need to be changed once running
			// multiple applications is possible
			commitToPin = app.commit;
			appToPin = appId;
			const serviceIds = _.keys(app.services);
			for (const serviceId of serviceIds) {
				const service = app.services[serviceId];
				const svc = {
					imageName: service.image,
					serviceName: service.serviceName,
					imageId: service.imageId,
					serviceId: parseInt(serviceId, 10),
					releaseId: app.releaseId,
					appId: parseInt(appId, 10),
				};
				imgs.push(imageFromService(svc));
			}
		}

		for (const image of imgs) {
			const name = images.normalise(image.name);
			image.name = name;
			await images.save(image);
		}

		const deviceConf = await deviceConfig.getCurrent();
		const formattedConf = deviceConfig.formatConfigKeys(preloadState.config);
		preloadState.config = { ...formattedConf, ...deviceConf };
		const localState = {
			local: { name: '', ...preloadState },
			dependent: { apps: {}, devices: {} },
		};

		await deviceState.setTarget(localState);
		log.success('Preloading complete');
		if (preloadState.pinDevice) {
			// Multi-app warning!
			// The following will need to be changed once running
			// multiple applications is possible
			if (commitToPin != null && appToPin != null) {
				log.debug('Device will be pinned');
				await config.set({
					pinDevice: {
						commit: commitToPin,
						app: parseInt(appToPin, 10),
					},
				});
			}
		}
		return true;
	} catch (e) {
		// Ensure that this is actually a file, and not an empty path
		// It can be an empty path because if the file does not exist
		// on host, the docker daemon creates an empty directory when
		// the bind mount is added
		if (ENOENT(e) || EISDIR(e)) {
			log.debug('No apps.json file present, skipping preload');
		} else {
			eventTracker.track('Loading preloaded apps failed', {
				error: e,
			});
		}
	} finally {
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
	return false;
}
