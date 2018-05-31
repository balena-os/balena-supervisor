import { EventEmitter } from 'events';

import { ServiceAction } from './device-api/common';
import { DeviceApplicationState } from './types/state';

import Images = require('./compose/images');
import ServiceManager = require('./compose/service-manager');
import DB = require('./db');

import { Service } from './types/service';

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
	public logger: any;
	public deviceState: any;
	public eventTracker: any;

	public services: ServiceManager;
	public db: DB;
	public images: Images;

	public getCurrentApp(appId: number): Promise<Application | null>;

	// TODO: This actually returns an object, but we don't need the values just yet
	public setTargetVolatileForService(serviceId: number, opts: Options): void;

	public executeStepAction(serviceAction: ServiceAction, opts: Options): Promise<void>;

	public getStatus(): Promise<DeviceApplicationState>;

}

export default ApplicationManager;
