import { expect } from 'chai';

import * as actions from '~/src/device-api/actions';

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
});
