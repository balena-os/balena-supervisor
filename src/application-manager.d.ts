import * as Bluebird from 'bluebird';
import { EventEmitter } from 'events';

import { ServiceAction } from './device-api/common';
import { EventTracker } from './event-tracker';
import { Logger } from './logger';
import { DeviceApplicationState } from './types/state';

import Images from './compose/images';
import ServiceManager from './compose/service-manager';
import DB from './db';

import { APIBinder } from './api-binder';
import { Service } from './compose/service';
import Config from './config';

declare interface Options {
	force?: boolean;
	running?: boolean;
	skipLock?: boolean;
}

// TODO: This needs to be moved to the correct module's typings
declare interface Application {
	services: Service[];
}

// This is a non-exhaustive typing for ApplicationManager to avoid
// having to recode the entire class (and all requirements in TS).
export class ApplicationManager extends EventEmitter {
	// These probably could be typed, but the types are so messy that we're
	// best just waiting for the relevant module to be recoded in typescript.
	// At least any types we can be sure of then.
	//
	// TODO: When the module which is/declares these fields is converted to
	// typecript, type the following
	public _lockingIfNecessary: any;
	public logger: Logger;
	public deviceState: any;
	public eventTracker: EventTracker;
	public apiBinder: APIBinder;

	public services: ServiceManager;
	public config: Config;
	public db: DB;
	public images: Images;

	public proxyvisor: any;

	public getCurrentApp(appId: number): Bluebird<Application | null>;

	// TODO: This actually returns an object, but we don't need the values just yet
	public setTargetVolatileForService(serviceId: number, opts: Options): void;

	public executeStepAction(
		serviceAction: ServiceAction,
		opts: Options,
	): Bluebird<void>;

	// FIXME: Type this properly as it's some mutant state between
	// the state endpoint and the ApplicationManager internals
	public getStatus(): Promise<Dictionay<any>>;

	public serviceNameFromId(serviceId: number): Bluebird<string>;
}

export default ApplicationManager;
