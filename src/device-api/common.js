import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import * as logger from '../logger';
import * as deviceState from '../device-state';
import * as applicationManager from '../compose/application-manager';
import * as serviceManager from '../compose/service-manager';
import * as volumeManager from '../compose/volume-manager';
import { InternalInconsistencyError } from '../lib/errors';
import { lock } from '../lib/update-lock';
import { appNotFoundMessage } from '../lib/messages';

export async function doRestart(appId, force) {
	await deviceState.initialized();
	await applicationManager.initialized();

	return lock(appId, { force }, () =>
		deviceState.getCurrentState().then(function (currentState) {
			if (currentState.local.apps?.[appId] == null) {
				throw new InternalInconsistencyError(
					`Application with ID ${appId} is not in the current state`,
				);
			}
			const allApps = currentState.local.apps;

			const app = allApps[appId];
			const imageIds = _.map(app.services, 'imageId');
			applicationManager.clearTargetVolatileForServices(imageIds);

			return deviceState.pausingApply(async () => {
				return Bluebird.each(app.services, async (service) => {
					await serviceManager.kill(service, { wait: true });
					await serviceManager.start(service);
				});
			});
		}),
	);
}

export async function doPurge(appId, force) {
	await deviceState.initialized();
	await applicationManager.initialized();

	logger.logSystemMessage(
		`Purging data for app ${appId}`,
		{ appId },
		'Purge data',
	);
	return lock(appId, { force }, () =>
		deviceState.getCurrentState().then(function (currentState) {
			const allApps = currentState.local.apps;

			if (allApps?.[appId] == null) {
				throw new Error(appNotFoundMessage);
			}

			const clonedState = safeStateClone(currentState);
			/**
			 * With multi-container, Docker adds an invalid network alias equal to the current containerId
			 * to that service's network configs when starting a service. Thus when reapplying intermediateState
			 * after purging, use a cloned state instance which automatically filters out invalid network aliases.
			 *
			 * This will prevent error logs like the following:
			 * https://gist.github.com/cywang117/84f9cd4e6a9641dbed530c94e1172f1d#file-logs-sh-L58
			 *
			 * When networks do not match because of their aliases, services are killed and recreated
			 * an additional time which is unnecessary. Filtering prevents this additional restart BUT
			 * it is a stopgap measure until we can keep containerId network aliases from being stored
			 * in state's service config objects (TODO)
			 *
			 * See https://github.com/balena-os/balena-supervisor/blob/master/src/device-api/common.js#L160-L180
			 * for a more in-depth explanation of why aliases need to be filtered out.
			 */

			// After cloning, set services & volumes as empty to be applied as intermediateTargetState
			allApps[appId].services = [];
			allApps[appId].volumes = {};

			applicationManager.setIsApplyingIntermediate(true);

			return deviceState
				.pausingApply(() =>
					deviceState
						.applyIntermediateTarget(currentState, { skipLock: true })
						.then(() => {
							// Now that we're not running anything, explicitly
							// remove the volumes, we must do this here, as the
							// application-manager will not remove any volumes
							// which are part of an active application
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
		}),
	)
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
}

/**
 * This doesn't truly return an InstancedDeviceState, but it's close enough to mostly work where it's used
 *
 * @returns { import('../types/state').InstancedDeviceState }
 */
export function safeStateClone(targetState) {
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

	/** @type { any } */
	const cloned = {
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

	return cloned;
}

export function safeAppClone(app) {
	const containerIdForService = _.fromPairs(
		_.map(app.services, (svc) => [
			svc.serviceName,
			svc.containerId != null ? svc.containerId.substr(0, 12) : '',
		]),
	);
	return {
		appId: app.appId,
		name: app.name,
		commit: app.commit,
		releaseId: app.releaseId,
		services: _.map(app.services, (svc) => {
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
	};
}
