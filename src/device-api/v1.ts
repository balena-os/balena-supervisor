import * as express from 'express';
import * as _ from 'lodash';

import { doRestart, doPurge } from './common';
import { AuthorizedRequest } from './types';
import * as eventTracker from '../event-tracker';
import { getApp } from '../device-state/db-format';
import * as applicationManager from '../compose/application-manager';
import { generateStep } from '../compose/composition-steps';
import * as commitStore from '../compose/commit';
import { checkInt, checkTruthy } from '../lib/validation';
import * as constants from '../lib/constants';

export function createV1Api(router: express.Router) {
	router.post('/v1/restart', (req: AuthorizedRequest, res, next) => {
		const appId = checkInt(req.body.appId);
		const force = checkTruthy(req.body.force);
		eventTracker.track('Restart container (v1)', { appId });
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}

		// handle the case where the appId is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			res.status(401).json({
				status: 'failed',
				message: 'Application is not available',
			});
			return;
		}

		return doRestart(appId, force)
			.then(() => res.status(200).send('OK'))
			.catch(next);
	});

	const v1StopOrStart = (
		req: AuthorizedRequest,
		res: express.Response,
		next: express.NextFunction,
		action: 'start' | 'stop',
	) => {
		const appId = checkInt(req.params.appId);
		const force = checkTruthy(req.body.force);
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}

		return Promise.all([applicationManager.getCurrentApps(), getApp(appId)])
			.then(([apps, targetApp]) => {
				if (apps[appId] == null) {
					return res.status(400).send('App not found');
				}
				const app = apps[appId];
				let service = app.services[0];
				if (service == null) {
					return res.status(400).send('No services on app');
				}
				if (app.services.length > 1) {
					return res
						.status(400)
						.send(
							'Some v1 endpoints are only allowed on single-container apps',
						);
				}

				// check that the request is scoped to cover this application
				if (!req.auth.isScoped({ apps: [app.appId] })) {
					return res.status(401).send('Unauthorized');
				}

				// Get the service from the target state (as we do in v2)
				// TODO: what if we want to start a service belonging to the current app?
				const targetService = _.find(targetApp.services, {
					serviceName: service.serviceName,
				});

				applicationManager.setTargetVolatileForService(service.imageId, {
					running: action !== 'stop',
				});

				const stopOpts = { wait: true };
				const step = generateStep(action, {
					current: service,
					target: targetService,
					...stopOpts,
				});

				return applicationManager
					.executeStep(step, { force })
					.then(function () {
						if (action === 'stop') {
							return service;
						}
						// We refresh the container id in case we were starting an app with no container yet
						return applicationManager.getCurrentApps().then(function (apps2) {
							const app2 = apps2[appId];
							service = app2.services[0];
							if (service == null) {
								throw new Error('App not found after running action');
							}
							return service;
						});
					})
					.then((service2) =>
						res.status(200).json({ containerId: service2.containerId }),
					);
			})
			.catch(next);
	};

	const createV1StopOrStartHandler = (action: 'start' | 'stop') =>
		_.partial(v1StopOrStart, _, _, _, action);

	router.post('/v1/apps/:appId/stop', createV1StopOrStartHandler('stop'));
	router.post('/v1/apps/:appId/start', createV1StopOrStartHandler('start'));

	router.get('/v1/apps/:appId', async (req: AuthorizedRequest, res, next) => {
		const appId = checkInt(req.params.appId);
		eventTracker.track('GET app (v1)', { appId });
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}

		try {
			const apps = await applicationManager.getCurrentApps();
			const app = apps[appId];
			const service = app?.services?.[0];
			if (service == null) {
				return res.status(400).send('App not found');
			}

			// handle the case where the appId is out of scope
			if (!req.auth.isScoped({ apps: [app.appId] })) {
				res.status(401).json({
					status: 'failed',
					message: 'Application is not available',
				});
				return;
			}

			if (app.services.length > 1) {
				return res
					.status(400)
					.send('Some v1 endpoints are only allowed on single-container apps');
			}

			// Because we only have a single app, we can fetch the commit for that
			// app, and maintain backwards compatability
			const commit = await commitStore.getCommitForApp(appId);

			// Don't return data that will be of no use to the user
			const appToSend = {
				appId,
				commit,
				containerId: service.containerId,
				env: _.omit(service.config.environment, constants.privateAppEnvVars),
				imageId: service.config.image,
				releaseId: service.releaseId,
			};

			return res.json(appToSend);
		} catch (e) {
			next(e);
		}
	});

	router.post('/v1/purge', (req: AuthorizedRequest, res, next) => {
		const appId = checkInt(req.body.appId);
		const force = checkTruthy(req.body.force);
		if (appId == null) {
			const errMsg = 'Invalid or missing appId';
			return res.status(400).send(errMsg);
		}

		// handle the case where the appId is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			res.status(401).json({
				status: 'failed',
				message: 'Application is not available',
			});
			return;
		}

		return doPurge(appId, force)
			.then(() => res.status(200).json({ Data: 'OK', Error: '' }))
			.catch(next);
	});
}
