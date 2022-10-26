import { expect } from 'chai';
import { spy, useFakeTimers } from 'sinon';

import * as actions from '~/src/device-api/actions';
import blink = require('~/lib/blink');

describe('device-api/actions', () => {
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
		// This suite doesn't test that the blink submodule writes to the correct
		// led file location on host. That test should be part of the blink module.
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
