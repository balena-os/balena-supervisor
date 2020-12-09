import * as readline from 'readline';
import * as _ from 'lodash';

import { docker } from '../lib/docker-utils';
import * as host from '../lib/host-utils';
import * as LogTypes from '../lib/log-types';
import log from '../lib/supervisor-console';

import * as logger from '../logger';
import { Overlay } from './overlay';
import { ServiceStatus } from './service';

export const getAll = async (): Promise<Overlay[]> => {
	const containers = await docker.listContainers({
		all: true,
		filters: { label: ['io.balena.app-uuid', 'io.balena.image.class=overlay'] },
	});

	return containers.map((container) => Overlay.fromDockerContainer(container));
};

export const getStatus = async () => {
	const overlays = await getAll();

	return overlays.map((overlay) => ({
		...overlay,
		status: 'Installed' as ServiceStatus,
	}));
};

export function toTargetState(overlays: Overlay[]) {
	const groups = _.groupBy(overlays, 'uuid');
	const apps = Object.keys(groups).reduce((allApps, uuid) => {
		const services = groups[uuid];
		const { appId, appName, releaseId, releaseVersion } = services[0]!;
		return {
			...allApps,
			[uuid]: {
				uuid,
				appId,
				name: appName,
				releaseId,
				releaseVersion,
				services: services.reduce(
					(allSvcs, svc, index) => ({
						...allSvcs,
						[String(index + 1)]: svc.toComposeObject(),
					}),
					{},
				),
				volumes: {},
				networks: {},
			},
		};
	}, {});

	return JSON.stringify({ apps });
}

export async function update(target: Overlay[]) {
	const args: string[] = [];
	if (target.length > 0) {
		args.push('-t');
		args.push(toTargetState(target));

		// Reboot after install
		args.push('-r');
	}

	logger.logSystemEvent(LogTypes.hostOverlayUpdate, {
		extensions: target.map((overlay) => overlay.imageName),
	});

	// Call the update script and wait for the process to finish
	await new Promise((resolve, reject) => {
		const process = host.spawn('update-data-store', args);

		// Pass process output to log
		const reader = readline.createInterface({ input: process.stderr! });
		reader.on('line', (line) => log.debug(line));

		process.on('exit', (exitCode) => {
			if (exitCode !== 0) {
				logger.logSystemEvent(LogTypes.hostOverlayUpdateError, {
					error: {
						message: `Host extensions update failed with code ${exitCode}`,
					},
				});

				reject(`Host extensions update failed with code ${exitCode}`);
				return;
			}
			logger.logSystemEvent(LogTypes.hostOverlayUpdateSuccess, {
				extensions: target.map((overlay) => overlay.imageName),
			});
			resolve(exitCode);
		});
	});
}
