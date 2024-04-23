import express from 'express';

import * as middleware from './middleware';
import * as apiKeys from './api-keys';
import * as actions from './actions';
import log from '../lib/supervisor-console';

import type { Server } from 'http';

interface SupervisorAPIConstructOpts {
	routers: express.Router[];
	healthchecks: Array<() => Promise<boolean>>;
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
			actions.identify();
			return res.sendStatus(200);
		});

		this.api.post(
			'/v1/regenerate-api-key',
			async (req: apiKeys.AuthorizedRequest, res, next) => {
				const { apiKey: oldKey } = req.auth;
				try {
					const newKey = await actions.regenerateKey(oldKey);
					return res.status(200).send(newKey);
				} catch (e: unknown) {
					next(e);
				}
			},
		);

		this.api.use(express.urlencoded({ limit: '10mb', extended: true }));
		this.api.use(express.json({ limit: '10mb' }));

		// And assign all external routers
		for (const router of this.routers) {
			this.api.use(router);
		}

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

	public async stop(): Promise<void> {
		if (this.server != null) {
			const server = this.server;
			this.server = null;
			return new Promise((resolve, reject) => {
				server.close((err: Error) => {
					if (err) {
						// In case the HTTP server fails to shut down,
						// make this.server available again for future attempts.
						this.server = server;
						return reject(err);
					} else {
						log.info('Stopped Supervisor API');
						return resolve();
					}
				});
			});
		} else {
			log.warn('Supervisor API already stopped, ignoring further requests');
		}
	}
}

export default SupervisorAPI;
