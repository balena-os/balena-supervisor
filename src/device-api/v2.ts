import * as Bluebird from 'bluebird';
import { Request, Response, Router } from 'express';
import * as _ from 'lodash';
import { fs } from 'mz';

import { ApplicationManager } from '../application-manager';
import { Service } from '../compose/service';
import { appNotFoundMessage, serviceNotFoundMessage } from '../lib/messages';
import { checkTruthy } from '../lib/validation';
import { doPurge, doRestart, serviceAction } from './common';

export function createV2Api(router: Router, applications: ApplicationManager) {

	const { _lockingIfNecessary, deviceState } = applications;

	const messageFromError = (err?: Error | string | null): string => {
		let message = 'Unknown error';
		if (err != null) {
			if (_.isError(err) && err.message != null) {
				message = err.message;
			} else {
				message = err as string;
			}
		}
		return message;
	};

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
					const service = _.find(app.services, { imageId }) as Service | null;
					if (service == null) {
						res.status(404).send(serviceNotFoundMessage);
						return;
					}
					applications.setTargetVolatileForService(
						service.imageId!,
						{ running: action !== 'stop' },
					);
					return applications.executeStepAction(
						serviceAction(
							action,
							service.serviceId!,
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
					res.status(503).send(messageFromError(err));
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
				res.status(503).send(messageFromError(err));
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

	router.get('/v2/local/target-state', async (_req, res) => {
		try {
			const localMode = checkTruthy(await deviceState.config.get('localMode'));
			if (!localMode) {
				return res.status(400).json({
					status: 'failed',
					message: 'Target state can only be retrieved when in local mode',
				});
			}

			res.status(200).json({
				status: 'success',
				state: await deviceState.getTarget(),
			});
		} catch (err) {
			res.status(503).send({
				status: 'failed',
				message: messageFromError(err),
			});
		}
	});

	router.post('/v2/local/target-state', async (req, res) => {
		// let's first ensure that we're in local mode, otherwise
		// this function should not do anything
		// TODO: We really should refactor the config module to provide bools
		// as bools etc
		try {
			const localMode = checkTruthy(await deviceState.config.get('localMode'));
			if (!localMode) {
				return res.status(400).json({
					status: 'failed',
					message: 'Target state can only set when device is in local mode',
				});
			}

			// Now attempt to set the state
			const force = req.body.force;
			const targetState = req.body;
			try {
				await deviceState.setTarget(targetState, true);
				await deviceState.triggerApplyTarget({ force });
				res.status(200).json({
					status: 'success',
					message: 'OK',
				});
			} catch (e) {
				res.status(400).json({
					status: 'failed',
					message: e.message,
				});
			}

		} catch (e) {
			const message = 'Could not apply target state: ';
			res.status(503).json({
				status: 'failed',
				message: message + messageFromError(e),
			});
		}
	});

	router.get('/v2/local/device-info', async (_req, res) => {
		// Return the device type and slug so that local mode builds can use this to
		// resolve builds
		try {

			// FIXME: We should be mounting the following file into the supervisor from the
			// start-resin-supervisor script, changed in meta-resin - but until then, hardcode it
			const data = await fs.readFile('/mnt/root/resin-boot/device-type.json', 'utf8');
			const deviceInfo = JSON.parse(data);


			return res.status(200).json({
				status: 'sucess',
				info: {
					arch: deviceInfo.arch,
					deviceType: deviceInfo.slug,
				},
			});

		} catch (e) {
			const message = 'Could not fetch device information: ';
			res.status(503).json({
				status: 'failed',
				message: message + messageFromError(e),
			});
		}
	});

	router.get('/v2/local/logs', async (_req, res) => {
		const backend = applications.logger.getLocalBackend();
		backend.assignServiceNameResolver(applications.serviceNameFromId.bind(applications));

		// Get the stream, and stream it into res
		const listenStream = backend.attachListener();

		listenStream.pipe(res);
	});
}
