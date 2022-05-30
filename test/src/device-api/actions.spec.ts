import { expect } from 'chai';
import { stub, restore, spy, useFakeTimers } from 'sinon';

import * as actions from '../../../src/device-api/actions';
import log from '../../../src/lib/supervisor-console';
import blink = require('../../../src/lib/blink');

describe('device-api/actions', () => {
	before(() => {
		// Disable log output during testing
		stub(log, 'debug');
		stub(log, 'warn');
		stub(log, 'info');
		stub(log, 'event');
		stub(log, 'success');
		stub(log, 'error');
	});

	after(() => {
		// Restore sinon stubs
		restore();
	});

	describe('runs healthchecks', () => {
		const taskTrue = () => Promise.resolve(true);
		const taskFalse = () => Promise.resolve(false);
		const taskError = () => {
			throw new Error();
		};

		it('resolves true if all healthchecks pass', async () => {
			expect(await actions.runHealthchecks([taskTrue, taskTrue])).to.be.true;
		});

		it('resolves false if any healthchecks throw an error or fail', async () => {
			expect(await actions.runHealthchecks([taskTrue, taskFalse])).to.be.false;
			expect(await actions.runHealthchecks([taskTrue, taskError])).to.be.false;
			expect(await actions.runHealthchecks([taskFalse, taskError])).to.be.false;
			expect(await actions.runHealthchecks([taskFalse, taskFalse])).to.be.false;
			expect(await actions.runHealthchecks([taskError, taskError])).to.be.false;
		});
	});

	describe('identifies device', () => {
		it('directs device to blink for set duration', async () => {
			const blinkStartSpy = spy(blink.pattern, 'start');
			const blinkStopSpy = spy(blink.pattern, 'stop');
			const clock = useFakeTimers();

			actions.identify();
			expect(blinkStartSpy.callCount).to.equal(1);
			clock.tick(15000);
			expect(blinkStopSpy.callCount).to.equal(1);

			blinkStartSpy.restore();
			blinkStopSpy.restore();
			clock.restore();
		});
	});
});
