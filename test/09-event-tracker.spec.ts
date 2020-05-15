import { Mixpanel } from 'mixpanel';
import * as mixpanel from 'mixpanel';
import { SinonStub, stub } from 'sinon';

import { expect } from './lib/chai-config';

import EventTracker from '../src/event-tracker';
import supervisorVersion = require('../src/lib/supervisor-version');

describe('EventTracker', () => {
	let eventTrackerOffline: EventTracker;
	let eventTracker: EventTracker;
	let initStub: SinonStub;

	before(() => {
		initStub = stub(mixpanel, 'init').callsFake(
			(token) =>
				(({
					token,
					track: stub().returns(undefined),
				} as unknown) as Mixpanel),
		);

		eventTrackerOffline = new EventTracker();
		eventTracker = new EventTracker();
		return stub(EventTracker.prototype as any, 'logEvent');
	});

	after(() => {
		(EventTracker.prototype as any).logEvent.restore();
		return initStub.restore();
	});

	it('initializes in unmanaged mode', () => {
		const promise = eventTrackerOffline.init({
			unmanaged: true,
			uuid: 'foobar',
			mixpanelHost: { host: '', path: '' },
			mixpanelToken: '',
		});
		expect(promise).to.be.fulfilled.then(() => {
			// @ts-ignore
			expect(eventTrackerOffline.client).to.be.null;
		});
	});

	it('logs events in unmanaged mode, with the correct properties', () => {
		eventTrackerOffline.track('Test event', { appId: 'someValue' });
		// @ts-ignore
		expect(eventTrackerOffline.logEvent).to.be.calledWith(
			'Event:',
			'Test event',
			JSON.stringify({ appId: 'someValue' }),
		);
	});

	it('initializes a mixpanel client when not in unmanaged mode', () => {
		const promise = eventTracker.init({
			mixpanelToken: 'someToken',
			uuid: 'barbaz',
			mixpanelHost: { host: '', path: '' },
			unmanaged: false,
		});
		expect(promise).to.be.fulfilled.then(() => {
			expect(mixpanel.init).to.have.been.calledWith('someToken');
			// @ts-ignore
			expect(eventTracker.client.token).to.equal('someToken');
			// @ts-ignore
			expect(eventTracker.client.track).to.be.a('function');
		});
	});

	it('calls the mixpanel client track function with the event, properties and uuid as distinct_id', () => {
		eventTracker.track('Test event 2', { appId: 'someOtherValue' });
		// @ts-ignore
		expect(eventTracker.logEvent).to.be.calledWith(
			'Event:',
			'Test event 2',
			JSON.stringify({ appId: 'someOtherValue' }),
		);
		// @ts-ignore
		expect(eventTracker.client.track).to.be.calledWith('Test event 2', {
			appId: 'someOtherValue',
			uuid: 'barbaz',
			distinct_id: 'barbaz',
			supervisorVersion,
		});
	});

	it('can be passed an Error and it is added to the event properties', () => {
		const theError = new Error('something went wrong');
		eventTracker.track('Error event', theError);
		// @ts-ignore
		expect(eventTracker.client.track).to.be.calledWith('Error event', {
			error: {
				message: theError.message,
				stack: theError.stack,
			},
			uuid: 'barbaz',
			distinct_id: 'barbaz',
			supervisorVersion,
		});
	});

	it('hides service environment variables, to avoid logging keys or secrets', () => {
		const props = {
			service: {
				appId: '1',
				environment: {
					RESIN_API_KEY: 'foo',
					RESIN_SUPERVISOR_API_KEY: 'bar',
					OTHER_VAR: 'hi',
				},
			},
		};
		eventTracker.track('Some app event', props);
		// @ts-ignore
		expect(eventTracker.client.track).to.be.calledWith('Some app event', {
			service: { appId: '1' },
			uuid: 'barbaz',
			distinct_id: 'barbaz',
			supervisorVersion,
		});
	});

	it('should handle being passed no properties object', () => {
		expect(eventTracker.track('no-options')).to.not.throw;
	});

	return describe('Rate limiting', () => {
		it('should rate limit events of the same type', () => {
			// @ts-ignore
			eventTracker.client.track.reset();

			eventTracker.track('test', {});
			eventTracker.track('test', {});
			eventTracker.track('test', {});
			eventTracker.track('test', {});
			eventTracker.track('test', {});

			// @ts-ignore
			expect(eventTracker.client.track).to.have.callCount(1);
		});

		it('should rate limit events of the same type with different arguments', () => {
			// @ts-ignore
			eventTracker.client.track.reset();

			eventTracker.track('test2', { a: 1 });
			eventTracker.track('test2', { b: 2 });
			eventTracker.track('test2', { c: 3 });
			eventTracker.track('test2', { d: 4 });
			eventTracker.track('test2', { e: 5 });

			// @ts-ignore
			expect(eventTracker.client.track).to.have.callCount(1);
		});

		it('should not rate limit events of different types', () => {
			// @ts-ignore
			eventTracker.client.track.reset();

			eventTracker.track('test3', { a: 1 });
			eventTracker.track('test4', { b: 2 });
			eventTracker.track('test5', { c: 3 });
			eventTracker.track('test6', { d: 4 });
			eventTracker.track('test7', { e: 5 });

			// @ts-ignore
			expect(eventTracker.client.track).to.have.callCount(5);
		});
	});
});
