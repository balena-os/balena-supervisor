import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import * as hostConfig from '~/src/host-config';
import * as actions from '~/src/device-api/actions';

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
});
