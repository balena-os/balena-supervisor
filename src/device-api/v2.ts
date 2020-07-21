import * as Bluebird from 'bluebird';
import { NextFunction, Request, Response, Router } from 'express';
import * as _ from 'lodash';

import { ApplicationManager } from '../application-manager';
import * as deviceState from '../device-state';
import * as apiBinder from '../api-binder';
import { Service } from '../compose/service';
import Volume from '../compose/volume';
import * as config from '../config';
import * as db from '../db';
import * as deviceConfig from '../device-config';
import * as logger from '../logger';
import * as images from '../compose/images';
import * as volumeManager from '../compose/volume-manager';
import * as serviceManager from '../compose/service-manager';
import { spawnJournalctl } from '../lib/journald';
import {
	appNotFoundMessage,
	serviceNotFoundMessage,
	v2ServiceEndpointInputErrorMessage,
} from '../lib/messages';
import log from '../lib/supervisor-console';
import supervisorVersion = require('../lib/supervisor-version');
import { checkInt, checkTruthy } from '../lib/validation';
import { isVPNActive } from '../network';
import { doPurge, doRestart, safeStateClone, serviceAction } from './common';

export function createV2Api(router: Router, applications: ApplicationManager) {
	const { _lockingIfNecessary } = applications;

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
				.then((app) => {
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
						service = _.find(app.services, (svc) => svc.imageId === imageId);
					} else {
						service = _.find(
							app.services,
							(svc) => svc.serviceName === serviceName,
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
			const { force } = req.body;
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
				serviceManager.getStatus(),
				images.getStatus(),
				db.models('app').select(['appId', 'commit', 'name']),
				(
					services,
					imgs,
					apps: Array<{ appId: string; commit: string; name: string }>,
				) => {
					// Create an object which is keyed my application name
					const response: {
						[appName: string]: {
							appId: number;
							commit: string;
							services: {
								[serviceName: string]: {
									status?: string;
									releaseId: number;
									downloadProgress: number | null;
								};
							};
						};
					} = {};

					const appNameById: { [id: number]: string } = {};

					apps.forEach((app) => {
						const appId = parseInt(app.appId, 10);
						response[app.name] = {
							appId,
							commit: app.commit,
							services: {},
						};

						appNameById[appId] = app.name;
					});

					imgs.forEach((img) => {
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

						let status: string | undefined;
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
		async (req: Request, res: Response) => {
			// Check application ID provided is valid
			const appId = checkInt(req.params.appId);
			if (!appId) {
				return res.status(400).json({
					status: 'failed',
					message: `Invalid application ID: ${req.params.appId}`,
				});
			}
			// Query device for all applications
			let apps: any;
			try {
				apps = await applications.getStatus();
			} catch (e) {
				log.error(e.message);
				return res.status(500).json({
					status: 'failed',
					message: `Unable to retrieve state for application ID: ${appId}`,
				});
			}
			// Check if the application exists
			if (!(appId in apps.local)) {
				return res.status(409).json({
					status: 'failed',
					message: `Application ID does not exist: ${appId}`,
				});
			}
			// Filter applications we do not want
			for (const app in apps.local) {
				if (app !== appId.toString()) {
					delete apps.local[app];
				}
			}
			// Return filtered applications
			return res.status(200).json(apps);
		},
	);

	router.get('/v2/local/target-state', async (_req, res) => {
		const targetState = await deviceState.getTarget();
		const target = safeStateClone(targetState);

		res.status(200).json({
			status: 'success',
			state: target,
		});
	});

	router.post('/v2/local/target-state', async (req, res) => {
		// let's first ensure that we're in local mode, otherwise
		// this function should not do anything
		const localMode = await config.get('localMode');
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
			const { deviceType, deviceArch } = await config.getMany([
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
		const serviceNameCache: { [sId: number]: string } = {};
		const backend = logger.getLocalBackend();
		// Cache the service names to IDs per call to the endpoint
		backend.assignServiceNameResolver(async (id: number) => {
			if (id in serviceNameCache) {
				return serviceNameCache[id];
			} else {
				const name = await applications.serviceNameFromId(id);
				serviceNameCache[id] = name;
				return name;
			}
		});

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
		const services = await serviceManager.getAll();

		if (req.query.serviceName != null || req.query.service != null) {
			const serviceName = req.query.serviceName || req.query.service;
			const service = _.find(
				services,
				(svc) => svc.serviceName === serviceName,
			);
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
		const currentRelease = await config.get('currentCommit');

		const pending = deviceState.isApplyInProgress();
		const containerStates = (await serviceManager.getAll()).map((svc) =>
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
		const imagesStates = (await images.getStatus()).map((img) => {
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
		const deviceName = await config.get('name');
		res.json({
			status: 'success',
			deviceName,
		});
	});

	router.get('/v2/device/tags', async (_req, res) => {
		try {
			const tags = await apiBinder.fetchDeviceTags();
			return res.json({
				status: 'success',
				tags,
			});
		} catch (e) {
			res.status(500).json({
				status: 'failed',
				message: e.message,
			});
		}
	});

	router.get('/v2/device/vpn', async (_req, res) => {
		const conf = await deviceConfig.getCurrent();
		// Build VPNInfo
		const info = {
			enabled: conf.SUPERVISOR_VPN_CONTROL === 'true',
			connected: await isVPNActive(),
		};
		// Return payload
		return res.json({
			status: 'success',
			vpn: info,
		});
	});

	router.get('/v2/cleanup-volumes', async (_req, res) => {
		const targetState = await applications.getTargetApps();
		const referencedVolumes: string[] = [];
		_.each(targetState, (app) => {
			_.each(app.volumes, (vol) => {
				referencedVolumes.push(Volume.generateDockerName(vol.appId, vol.name));
			});
		});
		await volumeManager.removeOrphanedVolumes(referencedVolumes);
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
		// We know stdout will be present
		journald.stdout!.pipe(res);
		res.on('close', () => {
			journald.kill('SIGKILL');
		});
		journald.on('exit', () => {
			journald.stdout!.unpipe();
			res.end();
		});
	});
}
