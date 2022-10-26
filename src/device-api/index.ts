import * as express from 'express';
import * as _ from 'lodash';

import * as middleware from './middleware';
import * as apiKeys from './api-keys';
import * as actions from './actions';
import * as eventTracker from '../event-tracker';
import { reportCurrentState } from '../device-state';
import proxyvisor from '../proxyvisor';
import blink = require('../lib/blink');
import log from '../lib/supervisor-console';

import type { Server } from 'http';

interface SupervisorAPIConstructOpts {
	routers: express.Router[];
	healthchecks: Array<() => Promise<boolean>>;
}

interface SupervisorAPIStopOpts {
	errored: boolean;
}

// API key methods
// For better black boxing, device-api should serve as the interface
// to the rest of the Supervisor code for accessing API key related methods.
export const getGlobalApiKey = apiKeys.getGlobalApiKey;
export const refreshKey = apiKeys.refreshKey;
export const generateScopedKey = apiKeys.generateScopedKey;
export const getScopesForKey = apiKeys.getScopesForKey;

export class SupervisorAPI {
	private routers: express.Router[];
	private healthchecks: Array<() => Promise<boolean>>;

	private api = express();
	private server: Server | null = null;

	public constructor({ routers, healthchecks }: SupervisorAPIConstructOpts) {
		this.routers = routers;
		this.healthchecks = healthchecks;

		this.api.disable('x-powered-by');
		this.api.use(middleware.logging);

		this.api.get('/v1/healthy', async (_req, res) => {
			const isHealthy = await actions.runHealthchecks(this.healthchecks);
			if (isHealthy) {
				return res.sendStatus(200);
			} else {
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
			async (req: apiKeys.AuthorizedRequest, res) => {
				await apiKeys.initialized();

				// check if we're updating the cloud API key
				const shouldUpdateCloudKey =
					req.auth.apiKey === (await getGlobalApiKey());

				// regenerate the key...
				const newKey = await apiKeys.refreshKey(req.auth.apiKey);

				// if we need to update the cloud API with our new key
				if (shouldUpdateCloudKey) {
					// report the new key to the cloud API
					reportCurrentState({
						api_secret: newKey,
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

		this.api.use(proxyvisor.router);

		this.api.use(middleware.errors);
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
