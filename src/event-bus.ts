import { EventEmitter } from 'events';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';

export interface GlobalEvents {
	deviceProvisioned: void;
}

type GlobalEventEmitter = StrictEventEmitter<EventEmitter, GlobalEvents>;

export class GlobalEventBus extends (EventEmitter as new () => GlobalEventEmitter) {
	public constructor() {
		super();
	}
}

export const getInstance = _.once(() => new GlobalEventBus());
