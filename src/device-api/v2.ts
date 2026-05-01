import express from 'express';
import type { Response, NextFunction } from 'express';
import _ from 'lodash';

import * as deviceState from '../device-state';
import * as apiBinder from '../api-binder';
import * as applicationManager from '../compose/application-manager';
import type { CompositionStepAction } from '../compose/composition-steps';
import { Volume } from '../compose/volume';
import * as commitStore from '../compose/commit';
import * as config from '../config';
import * as db from '../db';
import * as logger from '../logging';
import * as images from '../compose/images';
import * as volumeManager from '../compose/volume-manager';
import * as serviceManager from '../compose/service-manager';
import { spawnJournalctl } from '../lib/journald';
import log from '../lib/supervisor-console';
import supervisorVersion from '../lib/supervisor-version';
import { checkInt, checkString, checkTruthy } from '../lib/validation';
import {
	isNotFoundError,
	isBadRequestError,
	BadRequestError,
} from '../lib/errors';
import { isVPNActive } from '../network';
import type { AuthorizedRequest } from '../lib/api-keys';
import { fromV2TargetState } from '../lib/legacy';
import * as actions from './actions';
import { v2ServiceEndpointError } from './messages';
import { setTags } from '../api-binder/tags';

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
	async (req: AuthorizedRequest, res: Response, next: NextFunction) => {
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

		try {
			await actions.doPurge(appId, force);
			res.status(200).send('OK');
		} catch (e) {
			next(e);
		}
	},
);

router.post(
	'/v2/applications/:appId/restart',
	async (req: AuthorizedRequest, res: Response, next: NextFunction) => {
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

		try {
			await actions.doRestart(appId, force);

			res.status(200).send('OK');
		} catch (e) {
			next(e);
		}
	},
);

router.get(
	'/v2/applications/state',
	async (req: AuthorizedRequest, res: Response, next: NextFunction) => {
		try {
			const [apps, appsState] = await Promise.all([
				// get the target apps from the database to augment the results returned
				// by applicationManager.getState
				db
					.models('app')
					.select(['appId', 'uuid', 'commit', 'releaseId', 'name']) as Promise<
					Array<{
						appId: number;
						uuid: string;
						releaseId: number;
						commit: string;
						name: string;
					}>
				>,
				applicationManager.getState(),
			]);

			const result = apps
				// only access scoped apps
				.filter(({ appId: $appId }) => req.auth.isScoped({ apps: [$appId] }))
				// re-index by app name and add relevant fields from the database
				.map(({ appId, commit, uuid, name, releaseId }) => {
					const updateStatus =
						appsState[uuid]?.releases[commit]?.update_status || 'done';
					const services = Object.fromEntries(
						Object.entries(
							appsState[uuid]?.releases[commit]?.services ?? {},
						).map(
							([svcName, { status, image, download_progress: dlProgress }]) => [
								svcName,
								{
									status,
									image,
									downloadProgress: dlProgress ?? null,
									releaseId: releaseId,
								},
							],
						),
					);

					return [
						name,
						{
							appId,
							appUuid: uuid,
							commit,
							updateStatus,
							services,
						},
					];
				});

			res.status(200).json(Object.fromEntries(result));
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
		deviceState.triggerApplyTarget({ force });
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

router.get('/v2/local/logs', (_req, res) => {
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

router.get('/v2/version', (_req, res) => {
	res.status(200).json({
		status: 'success',
		version: supervisorVersion,
	});
});

router.get('/v2/containerId', async (req: AuthorizedRequest, res) => {
	const services = (await serviceManager.getAll()).filter((service) =>
		req.auth.isScoped({ apps: [service.appId] }),
	);

	if (req.query.serviceName != null || req.query.service != null) {
		const serviceName = req.query.serviceName ?? req.query.service;
		const service = services.find((svc) => svc.serviceName === serviceName);
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
				.keyBy((s) => s.serviceName)
				.mapValues((s) => s.containerId)
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
	} catch (e: any) {
		log.error(e);
		res.status(500).json({
			status: 'failed',
			message: e.message,
		});
	}
});

router.patch('/v2/device/tags', async (req, res) => {
	try {
		const body = req.body as unknown;
		if (body == null || typeof body !== 'object') {
			throw new BadRequestError(
				'Invalid tags body, must be an object like `{[tagKey: string]: string}`',
			);
		}
		for (const [key, value] of Object.entries(body)) {
			if (typeof value !== 'string') {
				throw new BadRequestError(
					'Invalid tags body, must be an object like `{[tagKey: string]: string}`',
				);
			}
			if (/\s/.test(key)) {
				throw new BadRequestError('Tag keys cannot contain whitespace');
			}
		}

		await setTags(body as Record<string, string>);

		return res.status(202).json({
			status: 'success',
		});
	} catch (e: any) {
		if (e instanceof BadRequestError) {
			res.status(e.statusCode).json({
				status: 'failed',
				message: e.message,
			});
			return;
		}
		res.status(500).json({
			status: 'failed',
			message: e.message,
		});
	}
});

router.get('/v2/device/vpn', async (_req, res) => {
	const conf = await deviceState.getCurrentConfig();
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

router.get('/v2/cleanup-volumes', async (req: AuthorizedRequest, res) => {
	const targetState = await applicationManager.getTargetApps();
	const referencedVolumes = Object.values(targetState)
		// if this app isn't in scope of the request, do not cleanup it's volumes
		.filter((app) => req.auth.isScoped({ apps: [app.id] }))
		.flatMap((app) => {
			const [release] = Object.values(app.releases);
			// Return a list of the volume names
			return Object.keys(release?.volumes ?? {}).map((volumeName) =>
				Volume.generateDockerName(app.id, volumeName),
			);
		});

	await volumeManager.removeOrphanedVolumes(referencedVolumes);
	res.json({
		status: 'success',
	});
});

router.post('/v2/journal-logs', (req, res) => {
	const all = checkTruthy(req.body.all);
	const follow = checkTruthy(req.body.follow);
	const count = checkInt(req.body.count, { positive: true }) ?? undefined;
	const unit = req.body.unit;
	const format = req.body.format ?? 'short';
	const containerId = req.body.containerId;
	const since = req.body.since;
	const until = req.body.until;

	const journald = spawnJournalctl({
		all,
		follow,
		count,
		unit,
		format,
		containerId,
		since,
		until,
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
