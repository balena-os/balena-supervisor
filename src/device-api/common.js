import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { appNotFoundMessage } from '../lib/messages';

export function doRestart(applications, appId, force) {
	const { _lockingIfNecessary, deviceState } = applications;

	return _lockingIfNecessary(appId, { force }, () =>
		deviceState.getCurrentForComparison().then(function(currentState) {
			const app = currentState.local.apps[appId];
			const imageIds = _.map(app.services, 'imageId');
			applications.clearTargetVolatileForServices(imageIds);
			const stoppedApp = _.cloneDeep(app);
			stoppedApp.services = [];
			currentState.local.apps[appId] = stoppedApp;
			return deviceState
				.pausingApply(() =>
					deviceState
						.applyIntermediateTarget(currentState, { skipLock: true })
						.then(function() {
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
		deviceState.getCurrentForComparison().then(function(currentState) {
			const app = currentState.local.apps[appId];
			if (app == null) {
				throw new Error(appNotFoundMessage);
			}
			const purgedApp = _.cloneDeep(app);
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
							return Bluebird.each(volumes.getAllByAppId(appId), vol =>
								vol.remove(),
							);
						})
						.then(function() {
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
		.tapCatch(err =>
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
