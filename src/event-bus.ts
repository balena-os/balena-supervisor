import { EventEmitter } from 'events';
import _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';
import { TargetState } from './types/state';

export interface GlobalEvents {
	deviceProvisioned: void;
	targetStateChanged: TargetState;
}

type GlobalEventEmitter = StrictEventEmitter<EventEmitter, GlobalEvents>;

export class GlobalEventBus extends (EventEmitter as new () => GlobalEventEmitter) {
	public constructor() {
		super();
	}
}

export const getInstance = _.once(() => new GlobalEventBus());
