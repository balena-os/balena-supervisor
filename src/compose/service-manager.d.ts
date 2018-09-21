import { EventEmitter } from 'events';

import { Service } from '../compose/service';

// FIXME: Unfinished definition for this class...
declare class ServiceManager extends EventEmitter {
	public getStatus(): Service[];
}

export = ServiceManager;
