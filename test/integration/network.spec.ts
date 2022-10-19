import * as path from 'path';
import { promises as fs } from 'fs';
import { SinonStub } from 'sinon';
import { testfs } from 'mocha-pod';

import { expect } from 'chai';
import Log from '~/lib/supervisor-console';
import * as network from '~/src/network';
import * as constants from '~/src/lib/constants';

describe('network', () => {
	it('checks VPN connection status', async () => {
		const vpnStatusPath = path.join(constants.vpnStatusPath, 'active');

		// Logstub already exists as part of the test hooks
		const logStub = Log.info as SinonStub;

		// When VPN is inactive vpnStatusPath does not exist
		await expect(
			fs.access(vpnStatusPath),
			'VPN active file does not exist before testing',
		).to.be.rejected;
		await expect(network.isVPNActive()).to.eventually.equal(false);
		expect(logStub.lastCall?.lastArg).to.equal(`VPN connection is not active.`);

		// Test when VPN is active
		const testFs = await testfs({
			[vpnStatusPath]: '',
		}).enable();
		await expect(network.isVPNActive()).to.eventually.equal(true);
		expect(logStub.lastCall?.lastArg).to.equal(`VPN connection is active.`);

		// Restore file system
		await testFs.restore();
	});
});
