import * as express from 'express';
import * as _ from 'lodash';

import * as actions from './actions';
import { AuthorizedRequest } from './api-keys';
import * as eventTracker from '../event-tracker';
import { isReadyForUpdates } from '../api-binder';
import * as config from '../config';
import * as deviceState from '../device-state';

import * as constants from '../lib/constants';
import { checkInt, checkTruthy } from '../lib/validation';
import log from '../lib/supervisor-console';
import {
	UpdatesLockedError,
	isNotFoundError,
	isBadRequestError,
} from '../lib/errors';
import * as hostConfig from '../host-config';
import * as applicationManager from '../compose/application-manager';
import { CompositionStepAction } from '../compose/composition-steps';
import * as commitStore from '../compose/commit';
import * as TargetState from '../device-state/target-state';

const disallowedHostConfigPatchFields = ['local_ip', 'local_port'];

export const router = express.Router();

router.post('/v1/restart', (req: AuthorizedRequest, res, next) => {
	const appId = checkInt(req.body.appId);
	const force = checkTruthy(req.body.force);
	eventTracker.track('Restart container (v1)', { appId });
	if (appId == null) {
		return res.status(400).send('Missing app id');
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
		.then(() => res.status(200).send('OK'))
		.catch(next);
});

const handleLegacyServiceAction = (action: CompositionStepAction) => {
	return async (
		req: AuthorizedRequest,
		res: express.Response,
		next: express.NextFunction,
	) => {
		const appId = checkInt(req.params.appId);
		const force = checkTruthy(req.body.force);

		if (appId == null) {
			return res.status(400).send('Invalid app id');
		}

		if (!req.auth.isScoped({ apps: [appId] })) {
			return res.status(401).send('Unauthorized');
		}

		try {
			await actions.executeServiceAction({
				action,
				appId,
				force,
				isLegacy: true,
			});
			const service = await actions.getLegacyService(appId);
			return res.status(200).send({ containerId: service.containerId });
		} catch (e: unknown) {
			if (isNotFoundError(e) || isBadRequestError(e)) {
				return res.status(e.statusCode).send(e.statusMessage);
			} else {
				next(e);
			}
		}
	};
};

router.post('/v1/apps/:appId/stop', handleLegacyServiceAction('stop'));
router.post('/v1/apps/:appId/start', handleLegacyServiceAction('start'));

const rebootOrShutdown = async (
	req: express.Request,
	res: express.Response,
	action: deviceState.DeviceStateStepTarget,
) => {
	const override = await config.get('lockOverride');
	const force = checkTruthy(req.body.force) || override;
	try {
		const response = await deviceState.executeStepAction({ action }, { force });
		res.status(202).json(response);
	} catch (e: any) {
		const status = e instanceof UpdatesLockedError ? 423 : 500;
		res.status(status).json({
			Data: '',
			Error: (e != null ? e.message : undefined) || e || 'Unknown error',
		});
	}
};

router.post('/v1/reboot', (req, res) => rebootOrShutdown(req, res, 'reboot'));
router.post('/v1/shutdown', (req, res) =>
	rebootOrShutdown(req, res, 'shutdown'),
);

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
			return res.status(401).json({
				status: 'failed',
				message: 'Unauthorized',
			});
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
		return res.status(401).json({
			status: 'failed',
			message: 'Unauthorized',
		});
	}

	return actions
		.doPurge(appId, force)
		.then(() => res.status(200).json({ Data: 'OK', Error: '' }))
		.catch(next);
});

router.post('/v1/update', (req, res, next) => {
	eventTracker.track('Update notification');
	if (isReadyForUpdates()) {
		config
			.get('instantUpdates')
			.then((instantUpdates) => {
				if (instantUpdates) {
					TargetState.update(req.body.force, true).catch(_.noop);
					res.sendStatus(204);
				} else {
					log.debug(
						'Ignoring update notification because instant updates are disabled',
					);
					res.sendStatus(202);
				}
			})
			.catch(next);
	} else {
		res.sendStatus(202);
	}
});

router.get('/v1/device/host-config', (_req, res) =>
	hostConfig
		.get()
		.then((conf) => res.json(conf))
		.catch((err) =>
			res.status(503).send(err?.message ?? err ?? 'Unknown error'),
		),
);

router.patch('/v1/device/host-config', async (req, res) => {
	// Because v1 endpoints are legacy, and this endpoint might already be used
	// by multiple users, adding too many throws might have unintended side effects.
	// Thus we're simply logging invalid fields and allowing the request to continue.

	try {
		if (!req.body.network) {
			log.warn("Key 'network' must exist in PATCH body");
			// If network does not exist, skip all field validation checks below
			throw new Error();
		}

		const { proxy } = req.body.network;

		// Validate proxy fields, if they exist
		if (proxy && Object.keys(proxy).length) {
			const blacklistedFields = Object.keys(proxy).filter((key) =>
				disallowedHostConfigPatchFields.includes(key),
			);

			if (blacklistedFields.length > 0) {
				log.warn(`Invalid proxy field(s): ${blacklistedFields.join(', ')}`);
			}

			if (
				proxy.type &&
				!constants.validRedsocksProxyTypes.includes(proxy.type)
			) {
				log.warn(
					`Invalid redsocks proxy type, must be one of ${constants.validRedsocksProxyTypes.join(
						', ',
					)}`,
				);
			}

			if (proxy.noProxy && !Array.isArray(proxy.noProxy)) {
				log.warn('noProxy field must be an array of addresses');
			}
		}
	} catch (e) {
		/* noop */
	}

	try {
		// If hostname is an empty string, return first 7 digits of device uuid
		if (req.body.network?.hostname === '') {
			const uuid = await config.get('uuid');
			req.body.network.hostname = uuid?.slice(0, 7);
		}
		const lockOverride = await config.get('lockOverride');
		await hostConfig.patch(
			req.body,
			checkTruthy(req.body.force) || lockOverride,
		);
		res.status(200).send('OK');
	} catch (err: any) {
		// TODO: We should be able to throw err if it's UpdatesLockedError
		// and the error middleware will handle it, but this doesn't work in
		// the test environment. Fix this when fixing API tests.
		if (err instanceof UpdatesLockedError) {
			return res.status(423).send(err?.message ?? err);
		}
		res.status(503).send(err?.message ?? err ?? 'Unknown error');
	}
});

router.get('/v1/device', async (_req, res) => {
	try {
		const state = await deviceState.getLegacyState();
		const stateToSend = _.pick(state.local, [
			'api_port',
			'ip_address',
			'os_version',
			'mac_address',
			'supervisor_version',
			'update_pending',
			'update_failed',
			'update_downloaded',
		]) as Dictionary<unknown>;
		if (state.local?.is_on__commit != null) {
			stateToSend.commit = state.local.is_on__commit;
		}
		const service = _.toPairs(
			_.toPairs(state.local?.apps)[0]?.[1]?.services,
		)[0]?.[1];

		if (service != null) {
			stateToSend.status = service.status;
			if (stateToSend.status === 'Running') {
				stateToSend.status = 'Idle';
			}
			stateToSend.download_progress = service.download_progress;
		}
		res.json(stateToSend);
	} catch (e: any) {
		res.status(500).json({
			Data: '',
			Error: (e != null ? e.message : undefined) || e || 'Unknown error',
		});
	}
});
