import * as express from 'express';
import * as _ from 'lodash';

import * as apiKeys from './api-keys';
import * as middleware from './middleware';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import blink = require('../lib/blink');
import log from '../lib/supervisor-console';

import type { Server } from 'http';
import type { AuthorizedRequest } from './types';

interface SupervisorAPIConstructOpts {
	routers: express.Router[];
	healthchecks: Array<() => Promise<boolean>>;
}

interface SupervisorAPIStopOpts {
	errored: boolean;
}

export class SupervisorAPI {
	private routers: express.Router[];
	private healthchecks: Array<() => Promise<boolean>>;

	private api = express();
	private server: Server | null = null;

	public constructor({ routers, healthchecks }: SupervisorAPIConstructOpts) {
		this.routers = routers;
		this.healthchecks = healthchecks;

		this.api.disable('x-powered-by');
		this.api.use(middleware.apiLogger);

		this.api.get('/v1/healthy', async (_req, res) => {
			try {
				const healths = await Promise.all(this.healthchecks.map((fn) => fn()));
				if (!_.every(healths)) {
					log.error('Healthcheck failed');
					return res.status(500).send('Unhealthy');
				}
				return res.sendStatus(200);
			} catch (_e) {
				log.error('Healthcheck failed');
				return res.status(500).send('Unhealthy');
			}
		});

		this.api.get('/ping', (_req, res) => res.send('OK'));

		this.api.use(middleware.auth);

		this.api.post('/v1/blink', (_req, res) => {
			eventTracker.track('Device blink');
			blink.pattern.start();
			setTimeout(blink.pattern.stop, 15000);
			return res.sendStatus(200);
		});

		// Expires the supervisor's API key and generates a new one.
		// It also communicates the new key to the balena API.
		this.api.post(
			'/v1/regenerate-api-key',
			async (req: AuthorizedRequest, res) => {
				await deviceState.initialized;
				await apiKeys.initialized;

				// check if we're updating the cloud API key
				const updateCloudKey = req.auth.apiKey === apiKeys.cloudApiKey;

				// regenerate the key...
				const newKey = await apiKeys.refreshKey(req.auth.apiKey);

				// if we need to update the cloud API with our new key
				if (updateCloudKey) {
					// report the new key to the cloud API
					deviceState.reportCurrentState({
						api_secret: apiKeys.cloudApiKey,
					});
				}

				// return the value of the new key to the caller
				res.status(200).send(newKey);
			},
		);

		this.api.use(express.urlencoded({ limit: '10mb', extended: true }));
		this.api.use(express.json({ limit: '10mb' }));

		// And assign all external routers
		for (const router of this.routers) {
			this.api.use(router);
		}

		this.api.use(middleware.errorHandler);
	}

	public async listen(port: number, apiTimeout: number): Promise<void> {
		return new Promise((resolve) => {
			this.server = this.api.listen(port, () => {
				log.info(`Supervisor API successfully started on port ${port}`);
				if (this.server) {
					this.server.timeout = apiTimeout;
				}
				return resolve();
			});
		});
	}

	public async stop(options?: SupervisorAPIStopOpts): Promise<void> {
		if (this.server != null) {
			return new Promise((resolve, reject) => {
				this.server?.close((err: Error) => {
					if (err) {
						log.error('Failed to stop Supervisor API');
						return reject(err);
					}
					options?.errored
						? log.error('Stopped Supervisor API')
						: log.info('Stopped Supervisor API');
					return resolve();
				});
			});
		}
	}
}

export default SupervisorAPI;
