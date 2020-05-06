import * as Promise from 'bluebird';
import * as _ from 'lodash';
import * as constants from '../lib/constants';
import { checkInt, checkTruthy } from '../lib/validation';
import { doRestart, doPurge, serviceAction } from './common';

export const createV1Api = function(router, applications) {
	const { eventTracker } = applications;

	router.post('/v1/restart', function(req, res, next) {
		const appId = checkInt(req.body.appId);
		const force = checkTruthy(req.body.force) ?? false;
		eventTracker.track('Restart container (v1)', { appId });
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}
		return doRestart(applications, appId, force)
			.then(() => res.status(200).send('OK'))
			.catch(next);
	});

	const v1StopOrStart = function(req, res, next, action) {
		const appId = checkInt(req.params.appId);
		const force = checkTruthy(req.body.force) ?? false;
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}
		return applications
			.getCurrentApp(appId)
			.then(function(app) {
				let service = app?.app.services?.[0];
				if (service == null) {
					return res.status(400).send('App not found');
				}
				if (app.services.length > 1) {
					return res
						.status(400)
						.send(
							'Some v1 endpoints are only allowed on single-container apps',
						);
				}
				applications.setTargetVolatileForService(service.imageId, {
					running: action !== 'stop',
				});
				return applications
					.executeStepAction(
						serviceAction(action, service.serviceId, service, service, {
							wait: true,
						}),
						{ force },
					)
					.then(function() {
						if (action === 'stop') {
							return service;
						}
						// We refresh the container id in case we were starting an app with no container yet
						return applications.getCurrentApp(appId).then(function(app2) {
							service = app2?.services?.[0];
							if (service == null) {
								throw new Error('App not found after running action');
							}
							return service;
						});
					})
					.then(service2 =>
						res.status(200).json({ containerId: service2.containerId }),
					);
			})
			.catch(next);
	};

	const createV1StopOrStartHandler = action =>
		_.partial(v1StopOrStart, _, _, _, action);

	router.post('/v1/apps/:appId/stop', createV1StopOrStartHandler('stop'));
	router.post('/v1/apps/:appId/start', createV1StopOrStartHandler('start'));

	router.get('/v1/apps/:appId', function(req, res, next) {
		const appId = checkInt(req.params.appId);
		eventTracker.track('GET app (v1)', { appId });
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}
		return Promise.join(
			applications.getCurrentApp(appId),
			applications.getStatus(),
			function(app, status) {
				const service = app?.services?.[0];
				if (service == null) {
					return res.status(400).send('App not found');
				}
				if (app.services.length > 1) {
					return res
						.status(400)
						.send(
							'Some v1 endpoints are only allowed on single-container apps',
						);
				}
				// Don't return data that will be of no use to the user
				const appToSend = {
					appId,
					containerId: service.containerId,
					env: _.omit(service.environment, constants.privateAppEnvVars),
					releaseId: service.releaseId,
					imageId: service.image,
				};
				if (status.commit != null) {
					appToSend.commit = status.commit;
				}
				return res.json(appToSend);
			},
		).catch(next);
	});

	router.post('/v1/purge', function(req, res, next) {
		const appId = checkInt(req.body.appId);
		const force = checkTruthy(req.body.force) ?? false;
		if (appId == null) {
			const errMsg = 'Invalid or missing appId';
			return res.status(400).send(errMsg);
		}
		return doPurge(applications, appId, force)
			.then(() => res.status(200).json({ Data: 'OK', Error: '' }))
			.catch(next);
	});
};
