import * as express from 'express';
import type { Response, NextFunction } from 'express';
import * as _ from 'lodash';

import * as deviceState from '../device-state';
import * as applicationManager from '../compose/application-manager';
import { CompositionStepAction } from '../compose/composition-steps';
import { Service } from '../compose/service';
import * as commitStore from '../compose/commit';
import * as config from '../config';
import * as db from '../db';
import * as logger from '../logger';
import * as images from '../compose/images';
import * as serviceManager from '../compose/service-manager';
import log from '../lib/supervisor-console';
import { checkInt, checkString, checkTruthy } from '../lib/validation';
import {
	isNotFoundError,
	isBadRequestError,
	BadRequestError,
} from '../lib/errors';
import { AuthorizedRequest } from './api-keys';
import { fromV2TargetState } from '../lib/legacy';
import * as actions from './actions';
import { v2ServiceEndpointError } from './messages';

export const router = express.Router();

const handleServiceAction = (action: CompositionStepAction) => {
	return async (req: AuthorizedRequest, res: Response, next: NextFunction) => {
		const [appId, imageId, serviceName, force] = [
			checkInt(req.params.appId),
			checkInt(req.body.imageId),
			checkString(req.body.serviceName),
			checkTruthy(req.body.force),
		];

		if (!appId) {
			return res.status(400).json({
				status: 'failed',
				message: 'Invalid app id',
			});
		}

		if (!req.auth.isScoped({ apps: [appId] })) {
			return res.status(401).json({
				status: 'failed',
				message: 'Unauthorized',
			});
		}

		try {
			if (!serviceName && !imageId) {
				throw new BadRequestError(v2ServiceEndpointError);
			}

			await actions.executeServiceAction({
				action,
				appId,
				imageId,
				serviceName,
				force,
			});
			return res.status(200).send('OK');
		} catch (e: unknown) {
			if (isNotFoundError(e) || isBadRequestError(e)) {
				return res.status(e.statusCode).send(e.statusMessage);
			} else {
				next(e);
			}
		}
	};
};

router.post(
	'/v2/applications/:appId/restart-service',
	handleServiceAction('restart'),
);

router.post(
	'/v2/applications/:appId/stop-service',
	handleServiceAction('stop'),
);

router.post(
	'/v2/applications/:appId/start-service',
	handleServiceAction('start'),
);

router.post(
	'/v2/applications/:appId/purge',
	(req: AuthorizedRequest, res: Response, next: NextFunction) => {
		const appId = checkInt(req.params.appId);
		const force = checkTruthy(req.body.force);
		if (!appId) {
			return res.status(400).json({
				status: 'failed',
				message: 'Missing app id',
			});
		}

		// handle the case where the application is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			return res.status(401).json({
				status: 'failed',
				message: 'Unauthorized',
			});
		}

		return actions
			.doPurge(appId, force)
			.then(() => {
				res.status(200).send('OK');
			})
			.catch(next);
	},
);

router.post(
	'/v2/applications/:appId/restart',
	(req: AuthorizedRequest, res: Response, next: NextFunction) => {
		const appId = checkInt(req.params.appId);
		const force = checkTruthy(req.body.force);
		if (!appId) {
			return res.status(400).json({
				status: 'failed',
				message: 'Missing app id',
			});
		}

		// handle the case where the appId is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			return res.status(401).json({
				status: 'failed',
				message: 'Unauthorized',
			});
		}

		return actions
			.doRestart(appId, force)
			.then(() => {
				res.status(200).send('OK');
			})
			.catch(next);
	},
);

router.get(
	'/v2/applications/state',
	async (req: AuthorizedRequest, res: Response, next: NextFunction) => {
		try {
			// It's very hacky to access the services and db via the application manager
			// refactor this code to use applicationManager.getState() instead.
			const [services, imgs, apps] = await Promise.all([
				serviceManager.getState(),
				images.getState(),
				db.models('app').select(['appId', 'commit', 'name']) as Promise<
					Array<{ appId: string; commit: string; name: string }>
				>,
			]);
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
			const commits: string[] = [];

			// only access scoped apps
			apps
				.filter((app) => req.auth.isScoped({ apps: [parseInt(app.appId, 10)] }))
				.forEach((app) => {
					const appId = parseInt(app.appId, 10);
					response[app.name] = {
						appId,
						commit: app.commit,
						services: {},
					};

					appNameById[appId] = app.name;
					commits.push(app.commit);
				});

			// only access scoped images
			imgs
				.filter(
					(img) =>
						req.auth.isScoped({ apps: [img.appId] }) &&
						// Ensure we are using the apps for the target release
						commits.includes(img.commit),
				)
				.forEach((img) => {
					const appName = appNameById[img.appId];
					if (appName == null) {
						log.warn(
							`Image found for unknown application!\nImage: ${JSON.stringify(
								img,
							)}`,
						);
						return;
					}

					const svc = _.find(services, (s: Service) => {
						return s.serviceName === img.serviceName && s.commit === img.commit;
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
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	'/v2/applications/:appId/state',
	async (req: AuthorizedRequest, res: Response) => {
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
			apps = await applicationManager.getLegacyState();
		} catch (e: any) {
			log.error(e.message);
			return res.status(500).json({
				status: 'failed',
				message: `Unable to retrieve state for application ID: ${appId}`,
			});
		}
		// Check if the application exists
		if (!(appId in apps.local) || !req.auth.isScoped({ apps: [appId] })) {
			return res.status(409).json({
				status: 'failed',
				message: `Application ID does not exist: ${appId}`,
			});
		}

		// handle the case where the appId is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			return res.status(401).json({
				status: 'failed',
				message: 'Unauthorized',
			});
		}

		// Filter applications we do not want
		for (const app in apps.local) {
			if (app !== appId.toString()) {
				delete apps.local[app];
			}
		}

		const commit = await commitStore.getCommitForApp(appId);

		// Return filtered applications
		return res.status(200).json({ commit, ...apps });
	},
);

router.get('/v2/local/target-state', async (_req, res) => {
	const target = await deviceState.getTarget();

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

	// Migrate target state from v2 to v3 to maintain API compatibility
	const targetState = await fromV2TargetState(req.body, true);

	try {
		await deviceState.setTarget(targetState, true);
		await deviceState.triggerApplyTarget({ force });
		res.status(200).json({
			status: 'success',
			message: 'OK',
		});
	} catch (e: any) {
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
	} catch (e: any) {
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
			const name = await applicationManager.serviceNameFromId(id);
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

router.get('/v2/version', (_req, res, next) => {
	try {
		const supervisorVersion = actions.getSupervisorVersion();
		return res.status(200).json({
			status: 'success',
			version: supervisorVersion,
		});
	} catch (e: unknown) {
		next(e);
	}
});

router.get('/v2/containerId', async (req: AuthorizedRequest, res) => {
	const services = (await serviceManager.getAll()).filter((service) =>
		req.auth.isScoped({ apps: [service.appId] }),
	);

	if (req.query.serviceName != null || req.query.service != null) {
		const serviceName = req.query.serviceName || req.query.service;
		const service = _.find(services, (svc) => svc.serviceName === serviceName);
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

router.get('/v2/state/status', async (req: AuthorizedRequest, res) => {
	const appIds: number[] = [];
	const pending = deviceState.isApplyInProgress();
	const containerStates = (await serviceManager.getAll())
		.filter((service) => req.auth.isScoped({ apps: [service.appId] }))
		.map((svc) => {
			appIds.push(svc.appId);
			return _.pick(
				svc,
				'status',
				'serviceName',
				'appId',
				'imageId',
				'serviceId',
				'containerId',
				'createdAt',
			);
		});

	let downloadProgressTotal = 0;
	let downloads = 0;
	const imagesStates = (await images.getState())
		.filter((img) => req.auth.isScoped({ apps: [img.appId] }))
		.map((img) => {
			appIds.push(img.appId);
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

	// This endpoint does not support multi-app but the device might be running multiple apps
	// We must return information for only 1 application so use the first one in the list
	const appId = appIds[0];
	// Get the commit for this application
	const commit = await commitStore.getCommitForApp(appId);
	// Filter containers by this application
	const appContainers = containerStates.filter((c) => c.appId === appId);
	// Filter images by this application
	const appImages = imagesStates.filter((i) => i.appId === appId);

	return res.status(200).send({
		status: 'success',
		appState: pending ? 'applying' : 'applied',
		overallDownloadProgress,
		containers: appContainers,
		images: appImages,
		release: commit,
	});
});

router.get('/v2/device/name', async (_req, res, next) => {
	try {
		const deviceName = await actions.getDeviceName();
		return res.json({
			status: 'success',
			deviceName,
		});
	} catch (e) {
		next(e);
	}
});

router.get('/v2/device/tags', async (_req, res) => {
	try {
		const tags = await actions.getDeviceTags();
		return res.json({
			status: 'success',
			tags,
		});
	} catch (e: unknown) {
		return res.status(500).json({
			status: 'failed',
			message: (e as Error).message ?? e,
		});
	}
});

router.get('/v2/device/vpn', async (_req, res, next) => {
	try {
		const vpnStatus = await actions.getVPNStatus();
		return res.json({
			status: 'success',
			vpn: vpnStatus,
		});
	} catch (e: unknown) {
		next(e);
	}
});

// This should be a POST but we have to keep it a GET for interface consistency
router.get('/v2/cleanup-volumes', async (req: AuthorizedRequest, res, next) => {
	try {
		await actions.cleanupVolumes(req.auth.isScoped);
		return res.json({
			status: 'success',
		});
	} catch (e: unknown) {
		next(e);
	}
});

router.post('/v2/journal-logs', (req, res, next) => {
	try {
		const opts = {
			all: checkTruthy(req.body.all),
			follow: checkTruthy(req.body.follow),
			count: checkInt(req.body.count, { positive: true }),
			unit: req.body.unit,
			format: req.body.format,
			containerId: req.body.containerId,
			since: req.body.since,
			until: req.body.until,
		};

		const journalProcess = actions.getLogStream(opts);
		res.status(200);

		journalProcess.stdout.pipe(res);
		res.on('close', () => {
			journalProcess.kill('SIGKILL');
		});
		journalProcess.on('exit', () => {
			journalProcess.stdout.unpipe();
			res.end();
		});
	} catch (e: unknown) {
		next(e);
	}
});
