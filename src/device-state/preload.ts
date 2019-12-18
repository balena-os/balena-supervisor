import * as _ from 'lodash';
import { fs } from 'mz';

import { Image } from '../compose/images';
import DeviceState from '../device-state';

import constants = require('../lib/constants');
import { AppsJsonParseError, EISDIR, ENOENT } from '../lib/errors';
import log from '../lib/supervisor-console';

import { convertLegacyAppsJson } from '../lib/migration';
import { AppsJsonFormat } from '../types/state';

export async function loadTargetFromFile(
	appsPath: Nullable<string>,
	deviceState: DeviceState,
): Promise<void> {
	log.info('Attempting to load any preloaded applications');
	if (!appsPath) {
		appsPath = constants.appsJsonPath;
	}

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
			stateFromFile = convertLegacyAppsJson(stateFromFile);
		}
		const preloadState = stateFromFile as AppsJsonFormat;

		let commitToPin: string | undefined;
		let appToPin: string | undefined;

		if (_.isEmpty(preloadState)) {
			return;
		}

		const images: Image[] = [];
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
					serviceId,
					releaseId: app.releaseId,
					appId,
				};
				images.push(await deviceState.applications.imageForService(svc));
			}
		}

		for (const image of images) {
			const name = await deviceState.applications.images.normalise(image.name);
			image.name = name;
			await deviceState.applications.images.save(image);
		}

		const deviceConf = await deviceState.deviceConfig.getCurrent();
		const formattedConf = await deviceState.deviceConfig.formatConfigKeys(
			preloadState.config,
		);
		preloadState.config = { ...formattedConf, ...deviceConf };
		const localState = { local: { name: '', ...preloadState } };

		await deviceState.setTarget(localState);

		log.success('Preloading complete');
		if (stateFromFile.pinDevice) {
			// Multi-app warning!
			// The following will need to be changed once running
			// multiple applications is possible
			if (commitToPin != null && appToPin != null) {
				log.debug('Device will be pinned');
				await deviceState.config.set({
					pinDevice: {
						commit: commitToPin,
						app: parseInt(appToPin, 10),
					},
				});
			}
		}
	} catch (e) {
		// Ensure that this is actually a file, and not an empty path
		// It can be an empty path because if the file does not exist
		// on host, the docker daemon creates an empty directory when
		// the bind mount is added
		if (ENOENT(e) || EISDIR(e)) {
			log.debug('No apps.json file present, skipping preload');
		} else {
			deviceState.eventTracker.track('Loading preloaded apps failed', {
				error: e,
			});
		}
	}
}
