import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import { getGlobalApiKey, refreshKey } from '.';
import * as messages from './messages';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import * as logger from '../logger';
import * as config from '../config';
import { App } from '../compose/app';
import * as applicationManager from '../compose/application-manager';
import * as serviceManager from '../compose/service-manager';
import * as volumeManager from '../compose/volume-manager';
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

import { InstancedDeviceState } from '../types';

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

	// Set volatile target state
	applicationManager.setTargetVolatileForService(currentService.imageId, {
		running: action !== 'stop',
	});

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
