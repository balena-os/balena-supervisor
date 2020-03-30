import * as Bluebird from 'bluebird';
import { NextFunction, Request, Response, Router } from 'express';
import * as _ from 'lodash';

import { ApplicationManager } from '../application-manager';
import { Service } from '../compose/service';
import {
	appNotFoundMessage,
	serviceNotFoundMessage,
	v2ServiceEndpointInputErrorMessage,
} from '../lib/messages';
import { doPurge, doRestart, serviceAction } from './common';

import Volume from '../compose/volume';
import { spawnJournalctl } from '../lib/journald';

import log from '../lib/supervisor-console';
import supervisorVersion = require('../lib/supervisor-version');
import { checkInt, checkTruthy } from '../lib/validation';

export function createV2Api(router: Router, applications: ApplicationManager) {
	const { _lockingIfNecessary, deviceState } = applications;

	const handleServiceAction = (
		req: Request,
		res: Response,
		next: NextFunction,
		action: any,
	): Resolvable<void> => {
		const { imageId, serviceName, force } = req.body;
		const appId = checkInt(req.params.appId);
		if (!appId) {
			res.status(400).json({
				status: 'failed',
				message: 'Missing app id',
			});
			return;
		}

		return _lockingIfNecessary(appId, { force }, () => {
			return applications
				.getCurrentApp(appId)
				.then(app => {
					if (app == null) {
						res.status(404).send(appNotFoundMessage);
						return;
					}

					// Work if we have a service name or an image id
					if (imageId == null) {
						if (serviceName == null) {
							throw new Error(v2ServiceEndpointInputErrorMessage);
						}
					}

					let service: Service | undefined;
					if (imageId != null) {
						service = _.find(app.services, svc => svc.imageId === imageId);
					} else {
						service = _.find(
							app.services,
							svc => svc.serviceName === serviceName,
						);
					}
					if (service == null) {
						res.status(404).send(serviceNotFoundMessage);
						return;
					}
					applications.setTargetVolatileForService(service.imageId!, {
						running: action !== 'stop',
					});
					return applications
						.executeStepAction(
							serviceAction(action, service.serviceId!, service, service, {
								wait: true,
							}),
							{ skipLock: true },
						)
						.then(() => {
							res.status(200).send('OK');
						});
				})
				.catch(next);
		});
	};

	const createServiceActionHandler = (action: string) =>
		_.partial(handleServiceAction, _, _, _, action);

	router.post(
		'/v2/applications/:appId/purge',
		(req: Request, res: Response, next: NextFunction) => {
			const force = checkTruthy(req.body.force) || false;
			const appId = checkInt(req.params.appId);
			if (!appId) {
				return res.status(400).json({
					status: 'failed',
					message: 'Missing app id',
				});
			}

			return doPurge(applications, appId, force)
				.then(() => {
					res.status(200).send('OK');
				})
				.catch(next);
		},
	);

	router.post(
		'/v2/applications/:appId/restart-service',
		createServiceActionHandler('restart'),
	);

	router.post(
		'/v2/applications/:appId/stop-service',
		createServiceActionHandler('stop'),
	);

	router.post(
		'/v2/applications/:appId/start-service',
		createServiceActionHandler('start'),
	);

	router.post(
		'/v2/applications/:appId/restart',
		(req: Request, res: Response, next: NextFunction) => {
			const { force } = req.body;
			const appId = checkInt(req.params.appId);
			if (!appId) {
				return res.status(400).json({
					status: 'failed',
					message: 'Missing app id',
				});
			}

			return doRestart(applications, appId, force)
				.then(() => {
					res.status(200).send('OK');
				})
				.catch(next);
		},
	);

	// TODO: Support dependent applications when this feature is complete
	router.get(
		'/v2/applications/state',
		async (_req: Request, res: Response, next: NextFunction) => {
			// It's kinda hacky to access the services and db via the application manager
			// maybe refactor this code
			Bluebird.join(
				applications.services.getStatus(),
				applications.images.getStatus(),
				applications.db.models('app').select(['appId', 'commit', 'name']),
				(
					services,
					images,
					apps: Array<{ appId: string; commit: string; name: string }>,
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
								};
							};
						};
					} = {};

					const appNameById: { [id: number]: string } = {};

					apps.forEach(app => {
						const appId = parseInt(app.appId, 10);
						response[app.name] = {
							appId,
							commit: app.commit,
							services: {},
						};

						appNameById[appId] = app.name;
					});

					images.forEach(img => {
						const appName = appNameById[img.appId];
						if (appName == null) {
							log.warn(
								`Image found for unknown application!\nImage: ${JSON.stringify(
									img,
								)}`,
							);
							return;
						}

						const svc = _.find(services, (service: Service) => {
							return service.imageId === img.imageId;
						});

						let status: string;
						if (svc == null) {
							status = img.status;
						} else {
							status = svc.status || img.status;
						}
						response[appName].services[img.serviceName] = {
							status,
							releaseId: img.releaseId,
							downloadProgress: img.downloadProgress || null,
						};
					});

					res.status(200).json(response);
				},
			).catch(next);
		},
	);

	router.get(
		'/v2/applications/:appId/state',
		(_req: Request, res: Response, next: NextFunction) => {
			// Get all services and their statuses, and return it
			applications
				.getStatus()
				.then(apps => {
					res.status(200).json(apps);
				})
				.catch(next);
		},
	);

	router.get('/v2/local/target-state', async (_req, res) => {
		const targetState = await deviceState.getTarget();

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

		const target: any = {
			local: {
				config: {},
			},
			dependent: {
				config: {},
			},
		};
		if (targetState.local != null) {
			target.local = {
				name: targetState.local.name,
				config: _.cloneDeep(targetState.local.config),
				apps: _.mapValues(targetState.local.apps, app => ({
					appId: app.appId,
					name: app.name,
					commit: app.commit,
					releaseId: app.releaseId,
					services: _.map(app.services, s => s.toComposeObject()),
					volumes: _.mapValues(app.volumes, v => v.toComposeObject()),
					networks: _.mapValues(app.networks, n => n.toComposeObject()),
				})),
			};
		}
		if (targetState.dependent != null) {
			target.dependent = _.cloneDeep(target.dependent);
		}

		res.status(200).json({
			status: 'success',
			state: target,
		});
	});

	router.post('/v2/local/target-state', async (req, res) => {
		// let's first ensure that we're in local mode, otherwise
		// this function should not do anything
		const localMode = await deviceState.config.get('localMode');
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
	});

	router.get('/v2/local/device-info', async (_req, res) => {
		try {
			const { deviceType, deviceArch } = await applications.config.getMany([
				'deviceType',
				'deviceArch',
			]);

			return res.status(200).json({
				status: 'success',
				info: {
					arch: deviceArch,
					deviceType,
				},
			});
		} catch (e) {
			res.status(500).json({
				status: 'failed',
				message: e.message,
			});
		}
	});

	router.get('/v2/local/logs', async (_req, res) => {
		const backend = applications.logger.getLocalBackend();
		backend.assignServiceNameResolver(
			applications.serviceNameFromId.bind(applications),
		);

		// Get the stream, and stream it into res
		const listenStream = backend.attachListener();

		// The http connection doesn't correctly intialise until some data is sent,
		// which means any callers waiting on the data being returned will hang
		// until the first logs comes through. To avoid this we send an initial
		// message
		res.write(
			`${JSON.stringify({ message: 'Streaming logs', isSystem: true })}\n`,
		);
		listenStream.pipe(res);
	});

	router.get('/v2/version', (_req, res) => {
		res.status(200).json({
			status: 'success',
			version: supervisorVersion,
		});
	});

	router.get('/v2/containerId', async (req, res) => {
		const services = await applications.services.getAll();

		if (req.query.serviceName != null || req.query.service != null) {
			const serviceName = req.query.serviceName || req.query.service;
			const service = _.find(services, svc => svc.serviceName === serviceName);
			if (service != null) {
				res.status(200).json({
					status: 'success',
					containerId: service.containerId,
				});
			} else {
				res.status(503).json({
					status: 'failed',
					message: 'Could not find service with that name',
				});
			}
		} else {
			res.status(200).json({
				status: 'success',
				services: _(services)
					.keyBy('serviceName')
					.mapValues('containerId')
					.value(),
			});
		}
	});

	router.get('/v2/state/status', async (_req, res) => {
		const currentRelease = await applications.config.get('currentCommit');

		const pending = applications.deviceState.applyInProgress;
		const containerStates = (await applications.services.getAll()).map(svc =>
			_.pick(
				svc,
				'status',
				'serviceName',
				'appId',
				'imageId',
				'serviceId',
				'containerId',
				'createdAt',
			),
		);

		let downloadProgressTotal = 0;
		let downloads = 0;
		const imagesStates = (await applications.images.getStatus()).map(img => {
			if (img.downloadProgress != null) {
				downloadProgressTotal += img.downloadProgress;
				downloads += 1;
			}
			return _.pick(
				img,
				'name',
				'appId',
				'serviceName',
				'imageId',
				'dockerImageId',
				'status',
				'downloadProgress',
			);
		});

		let overallDownloadProgress: number | null = null;
		if (downloads > 0) {
			overallDownloadProgress = downloadProgressTotal / downloads;
		}

		return res.status(200).send({
			status: 'success',
			appState: pending ? 'applying' : 'applied',
			overallDownloadProgress,
			containers: containerStates,
			images: imagesStates,
			release: currentRelease,
		});
	});

	router.get('/v2/device/name', async (_req, res) => {
		const deviceName = await applications.config.get('name');
		res.json({
			status: 'success',
			deviceName,
		});
	});

	router.get('/v2/device/tags', async (_req, res) => {
		const tags = await applications.apiBinder.fetchDeviceTags();
		return res.json({
			status: 'success',
			tags,
		});
	});

	router.get('/v2/cleanup-volumes', async (_req, res) => {
		const targetState = await applications.getTargetApps();
		const referencedVolumes: string[] = [];
		_.each(targetState, app => {
			_.each(app.volumes, vol => {
				referencedVolumes.push(Volume.generateDockerName(vol.appId, vol.name));
			});
		});
		await applications.volumes.removeOrphanedVolumes(referencedVolumes);
		res.json({
			status: 'success',
		});
	});

	router.post('/v2/journal-logs', (req, res) => {
		const all = checkTruthy(req.body.all) || false;
		const follow = checkTruthy(req.body.follow) || false;
		const count = checkInt(req.body.count, { positive: true }) || undefined;
		const unit = req.body.unit;
		const format = req.body.format || 'short';
		const containerId = req.body.containerId;

		const journald = spawnJournalctl({
			all,
			follow,
			count,
			unit,
			format,
			containerId,
		});
		res.status(200);
		journald.stdout.pipe(res);
		res.on('close', () => {
			journald.kill('SIGKILL');
		});
		journald.on('exit', () => {
			journald.stdout.unpipe();
			res.end();
		});
	});
}
