import * as _ from 'lodash';

import { Application } from '../types/application';

export const defaultLegacyVolume = () => 'resin-data';

export function singleToMulticontainerApp(app: Dictionary<any>): Application {
	const environment: Dictionary<string> = {};
	for (const key in app.env) {
		if (!/^RESIN_/.test(key)) {
			environment[key] = app.env[key];
		}
	}

	const { appId } = app;
	const conf = app.config != null ? app.config : {};
	const newApp = new Application();
	_.assign(newApp, {
		appId,
		commit: app.commit,
		name: app.name,
		releaseId: 1,
		networks: {},
		volumes: {},
	});
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
