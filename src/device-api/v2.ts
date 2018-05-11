import * as Bluebird from 'bluebird';
import { Response, Request, Router } from 'express';
import * as _ from 'lodash';

import ApplicationManager from '../application-manager';
import { doPurge, doRestart, serviceAction } from './common';

import { appNotFoundMessage, serviceNotFoundMessage } from '../lib/messages';

export function createV2Api(router: Router, applications: ApplicationManager) {

	const { _lockingIfNecessary } = applications;

	const handleServiceAction = (
		req: Request,
		res: Response,
		action: any,
	): Bluebird<void> => {
		const { imageId, force } = req.body;
		const { appId } = req.params;

		return _lockingIfNecessary(appId, { force }, () => {
			return applications.getCurrentApp(appId)
				.then((app) => {
					if (app == null) {
						res.status(404).send(appNotFoundMessage);
						return;
					}
					const service = _.find(app.services, { imageId });
					if (service == null) {
						res.status(404).send(serviceNotFoundMessage);
						return;
					}
					applications.setTargetVolatileForService(
						service.imageId,
						{ running: action !== 'stop' },
					);
					return applications.executeStepAction(
						serviceAction(
							action,
							service.serviceId,
							service,
							service,
							{ wait: true },
						),
						{ skipLock: true },
					)
						.then(() => {
							res.status(200).send('OK');
						});
				})
				.catch((err) => {
					let message;
					if (err != null) {
						if (err.message != null) {
							message = err.message;
						} else {
							message = err;
						}
					} else {
						message = 'Unknown error';
					}
					res.status(503).send(message);
				});
		});
	};

	router.post('/v2/applications/:appId/purge', (req: Request, res: Response) => {
		const { force } = req.body;
		const { appId } = req.params;

		return doPurge(applications, appId, force)
			.then(() => {
				res.status(200).send('OK');
			})
			.catch((err) => {
				let message;
				if (err != null) {
					message = err.message;
					if (message == null) {
						message = err;
					}
				} else {
					message = 'Unknown error';
				}
				res.status(503).send(message);
			});
	});

	router.post('/v2/applications/:appId/restart-service', (req: Request, res: Response) => {
		return handleServiceAction(req, res, 'restart');
	});

	router.post('/v2/applications/:appId/stop-service', (req: Request, res: Response) => {
		return handleServiceAction(req, res, 'stop');
	});

	router.post('/v2/applications/:appId/start-service', (req: Request, res: Response) => {
		return handleServiceAction(req, res, 'start');
	});

	router.post('/v2/applications/:appId/restart', (req: Request, res: Response) => {
		const { force } = req.body;
		const { appId } = req.params;

		return doRestart(applications, appId, force)
			.then(() => {
				res.status(200).send('OK');
			})
			.catch((err) => {
				let message;
				if (err != null) {
					message = err.message;
					if (message == null) {
						message = err;
					}
				} else {
					message = 'Unknown error';
				}
				res.status(503).send(message);
			});
	});

	// TODO: Support dependent applications when this feature is complete
	router.get('/v2/applications/state', (_req: Request, res: Response) => {

		// It's kinda hacky to access the services and db via the application manager
		// maybe refactor this code
		Bluebird.join(
			applications.services.getStatus(),
			applications.images.getStatus(),
			applications.db.models('app').select([ 'appId', 'commit', 'name' ]),
			(
				services,
				images,
				apps: Array<{ appId: string, commit: string, name: string }>,
			) => {
				// Create an object which is keyed my application name
				const response: {
					[appName: string]: {
						appId: number;
						commit: string;
						services: {
							[serviceName: string]: {
								status: string;
								releaseId: number;
								downloadProgress: number | null;
							}
						}
					}
				} = { };

				const appNameById: { [id: number]: string } = { };

				apps.forEach((app) => {
					const appId = parseInt(app.appId, 10);
					response[app.name] = {
						appId,
						commit: app.commit,
						services: { },
					};

					appNameById[appId] = app.name;
				});

				images.forEach((img) => {
					const appName = appNameById[img.appId];
					if (appName == null) {
						console.log('Image found for unknown application!');
						console.log('  Image: ', JSON.stringify(img));
						return;
					}

					const svc = _.find(services, (svc: Service) => {
						return svc.imageId === img.imageId;
					});

					let status: string;
					if (svc == null) {
						status = img.status;
					} else {
						status = svc.status;
					}
					response[appName].services[img.serviceName] = {
						status,
						releaseId: img.releaseId,
						downloadProgress: img.downloadProgress,
					};
				});

				res.status(200).json(response);
			});
	});

	router.get('/v2/applications/:appId/state', (_req: Request, res: Response) => {
		// Get all services and their statuses, and return it
		applications.getStatus()
			.then((apps) => {
				res.status(200).json(apps);
			});
	});
}
