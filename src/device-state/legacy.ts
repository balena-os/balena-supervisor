import _ from 'lodash';
import type { TargetAppsV2 } from '../lib/legacy';
import { fromV2TargetApps } from '../lib/legacy';
import type { AppsJsonFormat, TargetApp, TargetRelease } from '../types';

/**
 * Converts a single app from single container format into
 * multi-container, multi-app format (v3)
 *
 * This function doesn't pull ids from the cloud, but uses dummy values,
 * letting the normaliseLegacyDatabase() method perform the normalization
 */
function singleToMulticontainerApp(
	app: Dictionary<any>,
): TargetApp & { uuid: string } {
	const environment: Dictionary<string> = {};
	for (const key in app.env) {
		if (!/^RESIN_/.test(key)) {
			environment[key] = app.env[key];
		}
	}

	const { appId } = app;

	const release: TargetRelease = {
		id: 1,
		networks: {},
		volumes: {},
		services: {},
	};
	const conf = app.config != null ? app.config : {};
	const newApp: TargetApp & { uuid: string } = {
		id: appId,
		uuid: 'user-app',
		name: app.name,
		class: 'fleet',
		releases: {
			[app.commit]: release,
		},
	};
	const defaultVolume = exports.defaultLegacyVolume();
	release.volumes[defaultVolume] = {};
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
	release.services = {
		main: {
			id: 1,
			image_id: 1,
			image: app.imageId,
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
			running: true,
			composition: {
				restart: restartPolicy,
				privileged: true,
				networkMode: 'host',
				volumes: [`${defaultVolume}:/data`],
			},
		},
	};
	return newApp;
}

/**
 * Converts an apps.json from single container to multi-app (v3) format.
 */
export function fromLegacyAppsJson(appsArray: any[]): AppsJsonFormat {
	const deviceConfig = _.reduce(
		appsArray,
		(conf, app) => {
			return _.merge({}, conf, app.config);
		},
		{},
	);

	const apps = _.keyBy(
		_.map(appsArray, singleToMulticontainerApp),
		'uuid',
	) as Dictionary<TargetApp>;
	return { apps, config: deviceConfig } as AppsJsonFormat;
}

type AppsJsonV2 = {
	config: {
		[varName: string]: string;
	};
	apps: TargetAppsV2;
	pinDevice?: boolean;
};

export async function fromV2AppsJson(
	appsJson: AppsJsonV2,
): Promise<AppsJsonFormat> {
	const { config: conf, apps, pinDevice } = appsJson;

	const v3apps = await fromV2TargetApps(apps);
	return { config: conf, apps: v3apps, ...(pinDevice && { pinDevice }) };
}
