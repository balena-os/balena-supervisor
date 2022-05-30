import { expect } from 'chai';
import { stub, restore, spy, useFakeTimers, SinonStub } from 'sinon';

import { actions, apiKeys } from '../../../src/device-api';
import * as deviceState from '../../../src/device-state';
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

	describe('regenerates Supervisor API key', () => {
		let reportStateStub: SinonStub;

		beforeEach(() => {
			reportStateStub = stub(deviceState, 'reportCurrentState');
		});
		afterEach(() => reportStateStub.restore());

		it("communicates new key to cloud if it's a cloud key", async () => {
			const cloudKey = await apiKeys.generateCloudKey();
			const newKey = await actions.regenerateKey(cloudKey);
			expect(cloudKey).to.not.equal(newKey);
			expect(newKey).to.equal(apiKeys.cloudApiKey);
			expect(reportStateStub).to.have.been.calledOnce;
			expect(reportStateStub.firstCall.args[0]).to.deep.equal({
				api_secret: newKey,
			});
		});

		it("doesn't communicate new key if it's a service key", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			const newKey = await actions.regenerateKey(scopedKey);
			expect(scopedKey).to.not.equal(newKey);
			expect(newKey).to.not.equal(apiKeys.cloudApiKey);
			expect(reportStateStub).to.not.have.been.called;
		});
	});
});
