import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { appNotFoundMessage } from '../lib/messages';

export function doRestart(applications, appId, force) {
	const { _lockingIfNecessary, deviceState } = applications;

	return _lockingIfNecessary(appId, { force }, () =>
		deviceState.getCurrentForComparison().then(function (currentState) {
			const app = currentState.local.apps[appId];
			const imageIds = _.map(app.services, 'imageId');
			applications.clearTargetVolatileForServices(imageIds);

			const stoppedApp = safeAppClone(app);
			stoppedApp.services = [];
			currentState.local.apps[appId] = stoppedApp;
			return deviceState
				.pausingApply(() =>
					deviceState
						.applyIntermediateTarget(currentState, { skipLock: true })
						.then(function () {
							currentState.local.apps[appId] = app;
							return deviceState.applyIntermediateTarget(currentState, {
								skipLock: true,
							});
						}),
				)
				.finally(() => deviceState.triggerApplyTarget());
		}),
	);
}

export function doPurge(applications, appId, force) {
	const { logger, _lockingIfNecessary, deviceState, volumes } = applications;

	logger.logSystemMessage(
		`Purging data for app ${appId}`,
		{ appId },
		'Purge data',
	);
	return _lockingIfNecessary(appId, { force }, () =>
		deviceState.getCurrentForComparison().then(function (currentState) {
			console.log(JSON.stringify(currentState, null, 2));
			const app = currentState.local.apps[appId];
			if (app == null) {
				throw new Error(appNotFoundMessage);
			}

			const purgedApp = safeAppClone(app);
			purgedApp.services = [];
			purgedApp.volumes = {};
			currentState.local.apps[appId] = purgedApp;
			return deviceState
				.pausingApply(() =>
					deviceState
						.applyIntermediateTarget(currentState, { skipLock: true })
						.then(() => {
							// Now that we're not running anything, explicitly
							// remove the volumes, we must do this here, as the
							// application-manager will not remove any volumes
							// which are part of an active application
							return Bluebird.each(volumes.getAllByAppId(appId), (vol) =>
								vol.remove(),
							);
						})
						.then(function () {
							currentState.local.apps[appId] = app;
							return deviceState.applyIntermediateTarget(currentState, {
								skipLock: true,
							});
						}),
				)
				.finally(() => deviceState.triggerApplyTarget());
		}),
	)
		.tap(() =>
			logger.logSystemMessage('Purged data', { appId }, 'Purge data success'),
		)
		.tapCatch((err) =>
			logger.logSystemMessage(
				`Error purging data: ${err}`,
				{ appId, error: err },
				'Purge data error',
			),
		);
}

export function serviceAction(action, serviceId, current, target, options) {
	if (options == null) {
		options = {};
	}
	return { action, serviceId, current, target, options };
}

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
	return {
		appId: app.appId,
		name: app.name,
		commit: app.commit,
		releaseId: app.releaseId,
		services: _.map(app.services, (s) => s.toComposeObject()),
		volumes: _.mapValues(app.volumes, (v) => v.toComposeObject()),
		networks: _.mapValues(app.networks, (n) => n.toComposeObject()),
	};
}
