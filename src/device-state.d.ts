import { EventEmitter } from 'events';
import { Router } from 'express';

import ApplicationManager from './application-manager';
import Config from './config';
import Database from './db';
import DeviceConfig from './device-config';
import EventTracker from './event-tracker';
import Logger from './logger';

// This is a very incomplete definition of the device state
// class, which should be rewritten in typescript soon
class DeviceState extends EventEmitter {
	public applications: ApplicationManager;
	public router: Router;
	public deviceConfig: DeviceConfig;

	public constructor(args: {
		config: Config;
		db: Database;
		eventTracker: EventTracker;
		logger: Logger;
	});

	public healthcheck(): Promise<void>;
	public normaliseLegacy(client: PinejsClientRequest): Promise<void>;

	public async init();
}

export = DeviceState;
