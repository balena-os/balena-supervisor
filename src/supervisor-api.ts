import { NextFunction, Request, Response } from 'express';
import * as express from 'express';
import { Server } from 'http';
import * as _ from 'lodash';
import * as morgan from 'morgan';

import Config from './config';
import { EventTracker } from './event-tracker';
import blink = require('./lib/blink');
import * as iptables from './lib/iptables';
import { checkTruthy } from './lib/validation';

import log from './lib/supervisor-console';

function getKeyFromReq(req: express.Request): string | undefined {
	// Check query for key
	if (req.query.apikey) {
		return req.query.apikey;
	}
	// Get Authorization header to search for key
	const authHeader = req.get('Authorization');
	// Check header for key
	if (!authHeader) {
		return undefined;
	}
	// Check authHeader with various schemes
	const match = authHeader.match(/^(?:ApiKey|Bearer) (\w+)$/i);
	// Return key from match or undefined
	return match?.[1];
}

function authenticate(config: Config): express.RequestHandler {
	return async (req, res, next) => {
		try {
			const conf = await config.getMany([
				'apiSecret',
				'localMode',
				'unmanaged',
				'osVariant',
			]);

			const needsAuth = conf.unmanaged
				? conf.osVariant === 'prod'
				: !conf.localMode;

			if (needsAuth) {
				// Only get the key if we need it
				const key = getKeyFromReq(req);
				if (key && conf.apiSecret && key === conf.apiSecret) {
					return next();
				} else {
					return res.sendStatus(401);
				}
			} else {
				return next();
			}
		} catch (err) {
			res.status(503).send(`Unexpected error: ${err}`);
		}
	};
}

const expressLogger = morgan(
	(tokens, req, res) =>
		[
			tokens.method(req, res),
			req.path,
			tokens.status(req, res),
			'-',
			tokens['response-time'](req, res),
			'ms',
		].join(' '),
	{
		stream: { write: (d) => log.api(d.toString().trimRight()) },
	},
);

interface SupervisorAPIConstructOpts {
	config: Config;
	eventTracker: EventTracker;
	routers: express.Router[];
	healthchecks: Array<() => Promise<boolean>>;
}

interface SupervisorAPIStopOpts {
	errored: boolean;
}

export class SupervisorAPI {
	private config: Config;
	private eventTracker: EventTracker;
	private routers: express.Router[];
	private healthchecks: Array<() => Promise<boolean>>;

	private api = express();
	private server: Server | null = null;
	// Holds the function which should apply iptables rules
	private applyRules: SupervisorAPI['applyListeningRules'] =
		process.env.TEST === '1'
			? () => {
					// don't try to alter iptables
					// rules while we're running in tests
			  }
			: this.applyListeningRules.bind(this);

	public constructor({
		config,
		eventTracker,
		routers,
		healthchecks,
	}: SupervisorAPIConstructOpts) {
		this.config = config;
		this.eventTracker = eventTracker;
		this.routers = routers;
		this.healthchecks = healthchecks;

		this.api.disable('x-powered-by');
		this.api.use(expressLogger);

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

		this.api.use(authenticate(this.config));

		this.api.post('/v1/blink', (_req, res) => {
			this.eventTracker.track('Device blink');
			blink.pattern.start();
			setTimeout(blink.pattern.stop, 15000);
			return res.sendStatus(200);
		});

		// Expires the supervisor's API key and generates a new one.
		// It also communicates the new key to the balena API.
		this.api.post('/v1/regenerate-api-key', async (_req, res) => {
			const secret = await this.config.newUniqueKey();
			await this.config.set({ apiSecret: secret });
			res.status(200).send(secret);
		});

		// And assign all external routers
		for (const router of this.routers) {
			this.api.use(router);
		}

		// Error handling.

		const messageFromError = (err?: Error | string | null): string => {
			let message = 'Unknown error';
			if (err != null) {
				if (_.isError(err) && err.message != null) {
					message = err.message;
				} else {
					message = err as string;
				}
			}
			return message;
		};

		this.api.use(
			(err: Error, req: Request, res: Response, next: NextFunction) => {
				if (res.headersSent) {
					// Error happens while we are writing the response - default handler closes the connection.
					next(err);
					return;
				}
				log.error(`Error on ${req.method} ${req.path}: `, err);
				res.status(503).send({
					status: 'failed',
					message: messageFromError(err),
				});
			},
		);
	}

	public async listen(
		allowedInterfaces: string[],
		port: number,
		apiTimeout: number,
	): Promise<void> {
		const localMode = await this.config.get('localMode');
		await this.applyRules(localMode || false, port, allowedInterfaces);
		// Monitor the switching of local mode, and change which interfaces will
		// be listened to based on that
		this.config.on('change', (changedConfig) => {
			if (changedConfig.localMode != null) {
				this.applyRules(
					changedConfig.localMode || false,
					port,
					allowedInterfaces,
				);
			}
		});

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

	private async applyListeningRules(
		allInterfaces: boolean,
		port: number,
		allowedInterfaces: string[],
	): Promise<void> {
		try {
			if (checkTruthy(allInterfaces)) {
				await iptables.removeRejections(port);
				log.debug('Supervisor API listening on all interfaces');
			} else {
				await iptables.rejectOnAllInterfacesExcept(allowedInterfaces, port);
				log.debug('Supervisor API listening on allowed interfaces only');
			}
		} catch (err) {
			log.error('Error on switching supervisor API listening rules', err);
			return this.stop({ errored: true });
		}
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
