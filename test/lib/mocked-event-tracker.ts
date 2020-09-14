import * as eventTracker from '../../src/event-tracker';
import { spy } from 'sinon';

export const eventTrackSpy = spy(eventTracker, 'track');
