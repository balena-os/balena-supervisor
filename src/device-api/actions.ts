import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import { getGlobalApiKey, refreshKey } from '.';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import * as logger from '../logger';
import { App } from '../compose/app';
import * as applicationManager from '../compose/application-manager';
import * as serviceManager from '../compose/service-manager';
import * as volumeManager from '../compose/volume-manager';
import log from '../lib/supervisor-console';
import blink = require('../lib/blink');
import { lock } from '../lib/update-lock';
import { InternalInconsistencyError } from '../lib/errors';

import type { InstancedDeviceState } from '../types';

/**
 * Run an array of healthchecks, outputting whether all passed or not
 * Used by:
 * - GET /v1/healthy
 */
export const runHealthchecks = async (
	healthchecks: Array<() => Promise<boolean>>,
) => {
	const HEALTHCHECK_FAILURE = 'Healthcheck failed';

	try {
		const checks = await Promise.all(healthchecks.map((fn) => fn()));
		if (checks.some((check) => !check)) {
			throw new Error(HEALTHCHECK_FAILURE);
		}
	} catch {
		log.error(HEALTHCHECK_FAILURE);
		return false;
	}

	return true;
};

/**
 * Identify a device by blinking or some other method, if supported
 * Used by:
 * - POST /v1/blink
 */
const DEFAULT_IDENTIFY_DURATION = 15000;
export const identify = (ms: number = DEFAULT_IDENTIFY_DURATION) => {
	eventTracker.track('Device blink');
	blink.pattern.start();
	setTimeout(blink.pattern.stop, ms);
};

/**
 * Expires the supervisor's API key and generates a new one.
 * Also communicates the new key to the balena API, if it's a key
 * with global scope. The backend uses the global key to communicate
 * with the Supervisor.
 * Used by:
 * - POST /v1/regenerate-api-key
 */
export const regenerateKey = async (oldKey: string) => {
	const shouldReportUpdatedKey = oldKey === (await getGlobalApiKey());
	const newKey = await refreshKey(oldKey);

	if (shouldReportUpdatedKey) {
		deviceState.reportCurrentState({
			api_secret: newKey,
		});
	}

	return newKey;
};

/**
 * Restarts an application by recreating containers.
 * Used by:
 * - POST /v1/restart
 * - POST /v2/applications/:appId/restart
 */
export const doRestart = async (appId: number, force: boolean = false) => {
	await deviceState.initialized();

	return await lock(appId, { force }, async () => {
		const currentState = await deviceState.getCurrentState();
		if (currentState.local.apps?.[appId] == null) {
			throw new InternalInconsistencyError(
				`Application with ID ${appId} is not in the current state`,
			);
		}
		const { services } = currentState.local.apps?.[appId];
		applicationManager.clearTargetVolatileForServices(
			services.map((svc) => svc.imageId),
		);

		return deviceState.pausingApply(async () => {
			for (const service of services) {
				await serviceManager.kill(service, { wait: true });
				await serviceManager.start(service);
			}
		});
	});
};

/**
 * This doesn't truly return an InstancedDeviceState, but it's close enough to mostly work where it's used
 */
export function safeStateClone(
	targetState: InstancedDeviceState,
): InstancedDeviceState {
	// We avoid using cloneDeep here, as the class
	// instances can cause a maximum call stack exceeded
	// error

	// TODO: This should really return the config as it
	// is returned from the api, but currently that's not
	// the easiest thing due to the way they are stored and
	// retrieved from the db - when all of the application
	// manager is strongly typed, revisit this. The best
	// thing to do would be to represent the input with
	// io-ts and make sure the below conforms to it

	const cloned: DeepPartial<InstancedDeviceState> = {
		local: {
			config: {},
		},
		dependent: {
			config: {},
		},
	};

	if (targetState.local != null) {
		cloned.local = {
			name: targetState.local.name,
			config: _.cloneDeep(targetState.local.config),
			apps: _.mapValues(targetState.local.apps, safeAppClone),
		};
	}
	if (targetState.dependent != null) {
		cloned.dependent = _.cloneDeep(targetState.dependent);
	}

	return cloned as InstancedDeviceState;
}

export function safeAppClone(app: App): App {
	const containerIdForService = _.fromPairs(
		_.map(app.services, (svc) => [
			svc.serviceName,
			svc.containerId != null ? svc.containerId.substring(0, 12) : '',
		]),
	);
	return new App(
		{
			appId: app.appId,
			appUuid: app.appUuid,
			appName: app.appName,
			commit: app.commit,
			source: app.source,
			services: app.services.map((svc) => {
				// This is a bit of a hack, but when applying the target state as if it's
				// the current state, this will include the previous containerId as a
				// network alias. The container ID will be there as Docker adds it
				// implicitly when creating a container. Here, we remove any previous
				// container IDs before passing it back as target state. We have to do this
				// here as when passing it back as target state, the service class cannot
				// know that the alias being given is not in fact a user given one.
				// TODO: Make the process of moving from a current state to a target state
				// well-defined (and implemented in a separate module)
				const svcCopy = _.cloneDeep(svc);

				_.each(svcCopy.config.networks, (net) => {
					if (Array.isArray(net.aliases)) {
						net.aliases = net.aliases.filter(
							(alias) => alias !== containerIdForService[svcCopy.serviceName],
						);
					}
				});
				return svcCopy;
			}),
			volumes: _.cloneDeep(app.volumes),
			networks: _.cloneDeep(app.networks),
			isHost: app.isHost,
		},
		true,
	);
}

/**
 * Purges volumes for an application.
 * Used by:
 * - POST /v1/purge
 * - POST /v2/applications/:appId/purge
 */
export const doPurge = async (appId: number, force: boolean = false) => {
	await deviceState.initialized();

	logger.logSystemMessage(
		`Purging data for app ${appId}`,
		{ appId },
		'Purge data',
	);

	return await lock(appId, { force }, async () => {
		const currentState = await deviceState.getCurrentState();
		if (currentState.local.apps?.[appId] == null) {
			throw new InternalInconsistencyError(
				`Application with ID ${appId} is not in the current state`,
			);
		}

		const app = currentState.local.apps?.[appId];
		/**
		 * With multi-container, Docker adds an invalid network alias equal to the current containerId
		 * to that service's network configs when starting a service. Thus when reapplying intermediateState
		 * after purging, use a cloned state instance which automatically filters out invalid network aliases.
		 * This will prevent error logs like the following:
		 * https://gist.github.com/cywang117/84f9cd4e6a9641dbed530c94e1172f1d#file-logs-sh-L58
		 *
		 * When networks do not match because of their aliases, services are killed and recreated
		 * an additional time which is unnecessary. Filtering prevents this additional restart BUT
		 * it is a stopgap measure until we can keep containerId network aliases from being stored
		 * in state's service config objects (TODO)
		 */
		const clonedState = safeStateClone(currentState);
		// Set services & volumes as empty to be applied as intermediate state
		app.services = [];
		app.volumes = {};

		applicationManager.setIsApplyingIntermediate(true);

		return deviceState
			.pausingApply(() =>
				deviceState
					.applyIntermediateTarget(currentState, { skipLock: true })
					.then(() => {
						// Explicitly remove volumes because application-manager won't
						// remove any volumes that are part of an active application.
						return Bluebird.each(volumeManager.getAllByAppId(appId), (vol) =>
							vol.remove(),
						);
					})
					.then(() => {
						return deviceState.applyIntermediateTarget(clonedState, {
							skipLock: true,
						});
					}),
			)
			.finally(() => {
				applicationManager.setIsApplyingIntermediate(false);
				deviceState.triggerApplyTarget();
			});
	})
		.then(() =>
			logger.logSystemMessage('Purged data', { appId }, 'Purge data success'),
		)
		.catch((err) => {
			applicationManager.setIsApplyingIntermediate(false);

			logger.logSystemMessage(
				`Error purging data: ${err}`,
				{ appId, error: err },
				'Purge data error',
			);
			throw err;
		});
};
