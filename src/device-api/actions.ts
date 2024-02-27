import * as _ from 'lodash';

import { getGlobalApiKey, refreshKey } from '.';
import * as messages from './messages';
import { AuthorizedRequest } from './api-keys';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import * as logger from '../logger';
import * as config from '../config';
import * as hostConfig from '../host-config';
import { isVPNEnabled, isVPNActive } from '../network';
import { fetchDeviceTags } from '../api-binder';
import * as applicationManager from '../compose/application-manager';
import {
	CompositionStepAction,
	generateStep,
} from '../compose/composition-steps';
import * as commitStore from '../compose/commit';
import { getApp } from '../device-state/db-format';
import * as TargetState from '../device-state/target-state';
import log from '../lib/supervisor-console';
import blink = require('../lib/blink');
import { lock } from '../lib/update-lock';
import * as constants from '../lib/constants';
import {
	InternalInconsistencyError,
	NotFoundError,
	BadRequestError,
} from '../lib/errors';
import { JournalctlOpts, spawnJournalctl } from '../lib/journald';
import { supervisorVersion } from '../lib/supervisor-version';

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
		const app = currentState.local.apps[appId];
		const services = app.services;
		app.services = [];

		return deviceState
			.applyIntermediateTarget(currentState, {
				skipLock: true,
			})
			.then(() => {
				app.services = services;
				return deviceState.applyIntermediateTarget(currentState, {
					skipLock: true,
					keepVolumes: false,
				});
			})
			.finally(() => {
				deviceState.triggerApplyTarget();
			});
	});
};

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

		const app = currentState.local.apps[appId];

		// Delete the app from the current state
		delete currentState.local.apps[appId];

		return deviceState
			.applyIntermediateTarget(currentState, {
				skipLock: true,
				// Purposely tell the apply function to delete volumes so they can get
				// deleted even in local mode
				keepVolumes: false,
			})
			.then(() => {
				currentState.local.apps[appId] = app;
				return deviceState.applyIntermediateTarget(currentState, {
					skipLock: true,
				});
			})
			.finally(() => {
				deviceState.triggerApplyTarget();
			});
	})
		.then(() =>
			logger.logSystemMessage('Purged data', { appId }, 'Purge data success'),
		)
		.catch((err) => {
			logger.logSystemMessage(
				`Error purging data: ${err}`,
				{ appId, error: err },
				'Purge data error',
			);
			throw err;
		});
};

type ClientError = BadRequestError | NotFoundError;
/**
 * Get the current app by its appId from application manager, handling the
 * case of app not being found or app not having services. ClientError should be
 * BadRequestError if querying from a legacy endpoint (v1), otherwise NotFoundError.
 */
const getCurrentApp = async (
	appId: number,
	clientError: new (message: string) => ClientError,
) => {
	const currentApps = await applicationManager.getCurrentApps();
	const currentApp = currentApps[appId];
	if (currentApp == null || currentApp.services.length === 0) {
		// App with given appId doesn't exist, or app doesn't have any services.
		throw new clientError(messages.appNotFound);
	}
	return currentApp;
};

/**
 * Get service details from a legacy (single-container) app.
 * Will only return the first service for multi-container apps, so shouldn't
 * be used for multi-container. The routes that use this, use it to return
 * the containerId of the service after an action was executed on that service,
 * in keeping with the existing legacy interface.
 *
 * Used by:
 * - POST /v1/apps/:appId/stop
 * - POST /v1/apps/:appId/start
 */
export const getLegacyService = async (appId: number) => {
	return (await getCurrentApp(appId, BadRequestError)).services[0];
};

/**
 * Executes a device state action such as reboot, shutdown, or noop
 * Used by:
 * - POST /v1/reboot
 * - POST /v1/shutdown
 * - actions.executeServiceAction
 */
export const executeDeviceAction = async (
	step: Parameters<typeof deviceState.executeStepAction>[0],
	force: boolean = false,
) => {
	return await deviceState.executeStepAction(step, {
		force,
	});
};

/**
 * Executes a composition step action on a service.
 * isLegacy indicates that the action is being called from a legacy (v1) endpoint,
 * as a different error code is returned on certain failures to maintain the old interface.
 * Used by:
 * - POST /v1/apps/:appId/(stop|start)
 * - POST /v2/applications/:appId/(restart|stop|start)-service
 */
export const executeServiceAction = async ({
	action,
	appId,
	serviceName,
	imageId,
	force = false,
	isLegacy = false,
}: {
	action: CompositionStepAction;
	appId: number;
	serviceName?: string;
	imageId?: number;
	force?: boolean;
	isLegacy?: boolean;
}): Promise<void> => {
	// Get current and target apps
	const [currentApp, targetApp] = await Promise.all([
		getCurrentApp(appId, isLegacy ? BadRequestError : NotFoundError),
		getApp(appId),
	]);
	const isSingleContainer = currentApp.services.length === 1;
	if (!isSingleContainer && !serviceName && !imageId) {
		// App is multicontainer but no service parameters were provided
		throw new BadRequestError(messages.v2ServiceEndpointError);
	}

	// Find service in current and target apps
	const currentService = isSingleContainer
		? currentApp.services[0]
		: currentApp.services.find(
				(s) => s.imageId === imageId || s.serviceName === serviceName,
		  );
	if (currentService == null) {
		// Legacy (v1) throws 400 while v2 throws 404, and we have to keep the interface consistent.
		throw new (isLegacy ? BadRequestError : NotFoundError)(
			messages.serviceNotFound,
		);
	}
	const targetService = targetApp.services.find(
		(s) =>
			s.imageId === currentService.imageId ||
			s.serviceName === currentService.serviceName,
	);
	if (targetService == null) {
		throw new NotFoundError(messages.targetServiceNotFound);
	}

	// Execute action on service
	return await executeDeviceAction(
		generateStep(action, {
			current: currentService,
			target: targetService,
			wait: true,
		}),
		force,
	);
};

/**
 * Updates the target state cache of the Supervisor, which triggers an apply if applicable.
 * Used by:
 * - POST /v1/update
 */
export const updateTarget = async (force: boolean = false) => {
	eventTracker.track('Update notification');

	if (force || (await config.get('instantUpdates'))) {
		TargetState.update(force, true).catch(_.noop);
		return true;
	}

	log.debug(
		'Ignoring update notification because instant updates are disabled or force not specified',
	);
	return false;
};

/**
 * Get application information for a single-container app, throwing if multicontainer
 * Used by:
 * - GET /v1/apps/:appId
 */
export const getSingleContainerApp = async (appId: number) => {
	eventTracker.track('GET app (v1)', { appId });
	const apps = await applicationManager.getCurrentApps();
	const app = apps[appId];
	const service = app?.services?.[0];
	if (service == null) {
		// This should return a 404 Not Found, but we can't change the interface now so keep it as a 400
		throw new BadRequestError('App not found');
	}
	if (app.services.length > 1) {
		throw new BadRequestError(
			'Some v1 endpoints are only allowed on single-container apps',
		);
	}

	// Because we only have a single app, we can fetch the commit for that
	// app, and maintain backwards compatability
	const commit = await commitStore.getCommitForApp(appId);

	return {
		appId,
		commit,
		containerId: service.containerId,
		env: _.omit(service.config.environment, constants.privateAppEnvVars),
		imageId: service.config.image,
		releaseId: service.releaseId,
	};
};

/**
 * Returns legacy device info, update status, and service status for a single-container application.
 * Used by:
 * - GET /v1/device
 */
export const getLegacyDeviceState = async () => {
	const state = await deviceState.getLegacyState();
	const stateToSend = _.pick(state.local, [
		'api_port',
		'ip_address',
		'os_version',
		'mac_address',
		'supervisor_version',
		'update_pending',
		'update_failed',
		'update_downloaded',
	]) as Dictionary<any>;

	if (state.local?.is_on__commit != null) {
		stateToSend.commit = state.local.is_on__commit;
	}

	// NOTE: This only returns the status of the first service,
	// even in a multi-container app. We should deprecate this endpoint
	// in favor of a multi-container friendly device endpoint (which doesn't
	// exist yet), and use that for cloud dashboard diagnostic queries.
	const service = _.toPairs(
		_.toPairs(state.local?.apps)[0]?.[1]?.services,
	)[0]?.[1];

	if (service != null) {
		stateToSend.status = service.status;
		if (stateToSend.status === 'Running') {
			stateToSend.status = 'Idle';
		}
		stateToSend.download_progress = service.download_progress;
	}

	return stateToSend;
};

/**
 * Get host config from the host-config module; Returns proxy config and hostname.
 * Used by:
 * - GET /v1/device/host-config
 */
export const getHostConfig = async () => {
	return await hostConfig.get();
};

/**
 * Patch host configs such as proxy config and hostname
 * Used by:
 * - PATCH /v1/device/host-config
 */
export const patchHostConfig = async (
	conf: Parameters<typeof hostConfig.patch>[0],
	force: boolean,
) => {
	// If hostname is an empty string, return first 7 digits of device uuid
	if (conf.network?.hostname === '') {
		const uuid = await config.get('uuid');
		conf.network.hostname = uuid?.slice(0, 7);
	}
	await hostConfig.patch(conf, force);
};

/**
 * Get device VPN status
 * Used by:
 * - GET /v2/device/vpn
 */
export const getVPNStatus = async () => {
	return {
		enabled: await isVPNEnabled(),
		connected: await isVPNActive(),
	};
};

/**
 * Get device name
 * Used by:
 * - GET /v2/device/name
 */
export const getDeviceName = async () => {
	return await config.get('name');
};

/**
 * Get device tags
 * Used by:
 * - GET /v2/device/tags
 */
export const getDeviceTags = async () => {
	try {
		return await fetchDeviceTags();
	} catch (e: unknown) {
		log.error((e as Error).message ?? e);
		throw e;
	}
};

/**
 * Clean up orphaned volumes
 * Used by:
 * - GET /v2/cleanup-volumes
 */
export const cleanupVolumes = async (
	withScope: AuthorizedRequest['auth']['isScoped'] = () => true,
) => {
	// It's better practice to access engine functionality through application-manager
	// than through volume-manager directly, as the latter should be an internal module
	await applicationManager.removeOrphanedVolumes((id) =>
		withScope({ apps: [id] }),
	);
};

/**
 * Spawn a journalctl process with the given options
 * Used by:
 * - POST /v2/journal-logs
 */
export const getLogStream = (opts: JournalctlOpts) => {
	return spawnJournalctl(opts);
};

/**
 * Get version of running Supervisor
 * Used by:
 * - GET /v2/version
 */
export const getSupervisorVersion = () => {
	return supervisorVersion;
};

/**
 * Get the containerId(s) associated with a service.
 * If no serviceName is provided, get all containerIds.
 * Used by:
 * - GET /v2/containerId
 */
export const getContainerIds = async (
	serviceName: string = '',
	withScope: AuthorizedRequest['auth']['isScoped'] = () => true,
) => {
	const services = await applicationManager.getAllServices((id) =>
		withScope({ apps: [id] }),
	);

	// Return all containerIds if no serviceName is provided
	if (!serviceName) {
		return services.reduce(
			(svcToContainerIdMap, svc) => ({
				[svc.serviceName]: svc.containerId,
				...svcToContainerIdMap,
			}),
			{},
		);
	}

	// Otherwise, only return containerId of provided serviceNmae
	const service = services.find((svc) => svc.serviceName === serviceName);
	if (service != null) {
		return service.containerId;
	} else {
		throw new Error(`Could not find service with name '${serviceName}'`);
	}
};

/**
 * Get device type & arch
 * Used by:
 * - GET /v2/local/device-info
 */
export const getDeviceInfo = async () => {
	return await config.getMany(['deviceType', 'deviceArch']);
};
