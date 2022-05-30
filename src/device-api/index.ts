import * as express from 'express';
import * as _ from 'lodash';

import * as middleware from './middleware';
import * as actions from './actions';
import proxyvisor from '../proxyvisor';
import log from '../lib/supervisor-console';

import type { Server } from 'http';
import type { AuthorizedRequest } from './types';

export * as actions from './actions';
export * as apiKeys from './api-keys';
export * as common from './common';
export * as middleware from './middleware';
export * as v1 from './v1';
export * as v2 from './v2';

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
			async (req: AuthorizedRequest, res) => {
				const newKey = await actions.regenerateKey(req.auth.apiKey);
				return res.status(200).send(newKey);
			},
		);

		this.api.use(express.urlencoded({ limit: '10mb', extended: true }));
		this.api.use(express.json({ limit: '10mb' }));

		// And assign all external routers
		for (const router of this.routers) {
			this.api.use(router);
		}

		this.api.use(proxyvisor.router);

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
