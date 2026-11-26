import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import * as hostConfig from '~/src/host-config';
import * as actions from '~/src/device-api/actions';
import * as deviceState from '~/src/device-state';
import * as targetState from '~/src/device-state/target-state';
import * as logger from '~/src/logging';
import * as extraFirmware from '~/lib/extra-firmware';

describe('device-api/actions', () => {
	describe('runs healthchecks', () => {
		// eslint-disable-next-line @typescript-eslint/require-await
		const taskTrue = async () => true;
		// eslint-disable-next-line @typescript-eslint/require-await
		const taskFalse = async () => false;
		// eslint-disable-next-line @typescript-eslint/require-await
		const taskError = async () => {
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

	describe('gets host config', () => {
		// Stub external dependencies
		// TODO: host-config module integration tests
		let hostConfigGet: SinonStub;
		before(() => {
			hostConfigGet = stub(hostConfig, 'get');
		});
		after(() => {
			hostConfigGet.restore();
		});

		it('gets host config', async () => {
			const conf = {
				network: {
					proxy: {},
					hostname: 'deadbeef',
				},
			};
			hostConfigGet.resolves(conf);
			expect(await actions.getHostConfig()).to.deep.equal(conf);
		});
	});

	describe('purge and restart concurrency', () => {
		let withExclusiveApply: SinonStub;
		let setIntermediateTarget: SinonStub;
		let applyTarget: SinonStub;
		const stubs: SinonStub[] = [];

		beforeEach(() => {
			stubs.push(
				stub(deviceState, 'initialized').resolves(),
				stub(deviceState, 'getCurrentState').callsFake(() =>
					Promise.resolve({
						local: { apps: { 1: { services: [] } } },
					} as any),
				),
				stub(deviceState, 'triggerApplyTarget'),
				stub(logger, 'logSystemMessage'),
				stub(extraFirmware, 'remove').resolves(),
				stub(extraFirmware, 'create').resolves(),
				(withExclusiveApply = stub(deviceState, 'withExclusiveApply')),
				// device-state re-exports this, so stub it at its source
				(setIntermediateTarget = stub(targetState, 'setIntermediateTarget')),
				(applyTarget = stub(deviceState, 'applyTarget').resolves()),
			);
		});

		afterEach(() => {
			for (const s of stubs.splice(0)) {
				s.restore();
			}
		});

		it('clears the intermediate target before releasing the exclusive lock', async () => {
			let targetAtRelease: unknown = 'unset';
			withExclusiveApply.callsFake(async (fn) => {
				await fn(new AbortController().signal);
				targetAtRelease = setIntermediateTarget.lastCall.args[0];
			});

			await actions.doPurge(1);
			expect(targetAtRelease).to.be.null;

			await actions.doRestart(1);
			expect(targetAtRelease).to.be.null;
		});

		it('fails a purge that is interrupted instead of continuing', async () => {
			const ac = new AbortController();
			withExclusiveApply.callsFake(async (fn) => {
				ac.abort();
				await fn(ac.signal);
			});

			await expect(actions.doPurge(1)).to.be.rejectedWith(/interrupted/);
			expect(applyTarget).to.have.been.calledOnce;
			expect(extraFirmware.remove).to.not.have.been.called;
			expect(setIntermediateTarget.lastCall.args[0]).to.be.null;
		});
	});
});
