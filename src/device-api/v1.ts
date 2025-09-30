import express from 'express';
import type { Response } from 'express';

import * as actions from './actions';
import type { AuthorizedRequest } from '../lib/api-keys';
import * as eventTracker from '../event-tracker';
import type * as deviceState from '../device-state';

import { checkInt, checkTruthy } from '../lib/validation';
import log from '../lib/supervisor-console';
import {
	isNotFoundError,
	isBadRequestError,
	UpdatesLockedError,
} from '../lib/errors';
import type { CompositionStepAction } from '../compose/composition-steps';

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

const handleDeviceAction = (action: deviceState.DeviceStateStepTarget) => {
	return async (req: AuthorizedRequest, res: Response) => {
		const force = checkTruthy(req.body.force);
		try {
			await actions.executeDeviceAction({ action }, force);
			return res.status(202).send({ Data: 'OK', Error: null });
		} catch (e: unknown) {
			const status = e instanceof UpdatesLockedError ? 423 : 500;
			return res.status(status).json({
				Data: '',
				Error: (e as Error)?.message ?? e ?? 'Unknown error',
			});
		}
	};
};

router.post('/v1/reboot', handleDeviceAction('reboot'));
router.post('/v1/shutdown', handleDeviceAction('shutdown'));

router.get('/v1/apps/:appId', async (req: AuthorizedRequest, res, next) => {
	const appId = checkInt(req.params.appId);
	if (appId == null) {
		return res.status(400).send('Missing app id');
	}

	// handle the case where the appId is out of scope
	if (!req.auth.isScoped({ apps: [appId] })) {
		return res.status(401).json({
			status: 'failed',
			message: 'Application is not available',
		});
	}

	try {
		const app = await actions.getSingleContainerApp(appId);
		return res.json(app);
	} catch (e: unknown) {
		if (isBadRequestError(e) || isNotFoundError(e)) {
			return res.status(e.statusCode).send(e.statusMessage);
		}
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

router.post('/v1/update', async (req, res, next) => {
	const force = checkTruthy(req.body.force);
	const cancel = checkTruthy(req.body.cancel);
	try {
		const result = await actions.updateTarget(force, cancel);
		return res.sendStatus(result ? 204 : 202);
	} catch (e: unknown) {
		next(e);
	}
});

router.get('/v1/device/host-config', async (_req, res, next) => {
	try {
		const conf = await actions.getHostConfig();
		return res.json(conf);
	} catch (e: unknown) {
		next(e);
	}
});

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
	} catch {
		/* noop */
	}

	try {
		await actions.patchHostConfig(req.body, checkTruthy(req.body.force));
		return res.status(200).send('OK');
	} catch (e: unknown) {
		// Normally the error middleware handles 423 / 503 errors, however this interface
		// throws the errors in a different format (text) compared to the middleware (JSON).
		// Therefore we need to keep this here to keep the interface consistent.
		if (e instanceof UpdatesLockedError) {
			return res.status(423).send(e?.message ?? e);
		}

		// User input cannot be parsed to type HostConfiguration or LegacyHostConfiguration
		if (isBadRequestError(e)) {
			return res.status(e.statusCode).send(e.statusMessage);
		}

		return res.status(503).send((e as Error)?.message ?? e ?? 'Unknown error');
	}
});

router.get('/v1/device', async (_req, res, next) => {
	try {
		const state = await actions.getLegacyDeviceState();
		return res.json(state);
	} catch (e: unknown) {
		next(e);
	}
});
