import { EventEmitter } from 'events';
import _ from 'lodash';
import type StrictEventEmitter from 'strict-event-emitter-types';
import type { TargetState } from './types/state';

export interface GlobalEvents {
	deviceProvisioned: void;
	targetStateChanged: TargetState;
}

type GlobalEventEmitter = StrictEventEmitter<EventEmitter, GlobalEvents>;

export const getInstance = _.once(
	() => new EventEmitter() as GlobalEventEmitter,
);
