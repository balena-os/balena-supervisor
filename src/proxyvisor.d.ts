import * as express from 'express';

import Config from './config';
import Logger from './logger';
import Database, { Transaction } from './db';
import Docker from './lib/docker-utils';
import Images from './compose/images';
import ApplicationManager from './application-manager';

class Proxyvisor {
	public router: express.Router;
	public validActions: string[];

	public constructor({
		config: Config,
		logger: Logger,
		db: Database,
		docker: Docker,
		images: Images,
		applications: ApplicationManager,
	});

	public getCurrentStates(): Promise<unknown>;
	public setTargetInTransaction(dependent: unknown, trx: Transaction);
	public getTarget(): Promise<{ apps: unknown; devices: unknown }>;
}
export = Proxyvisor;
