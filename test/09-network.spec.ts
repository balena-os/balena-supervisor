import { fs } from 'mz';
import * as os from 'os';
import { stub, spy } from 'sinon';

import { expect } from './lib/chai-config';
import Log from '../src/lib/supervisor-console';
import * as network from '../src/network';

describe('network', () => {
	describe('getIPAddresses', () => {
		before(() =>
			stub(os, 'networkInterfaces').returns({
				lo: [
					{
						address: '127.0.0.1',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: true,
					},
					{
						address: '::1',
						netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
						family: 'IPv6',
						mac: '00:00:00:00:00:00',
						scopeid: 0,
						internal: true,
					},
				],
				docker0: [
					{
						address: '172.17.0.1',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '02:42:0f:33:06:ad',
						internal: false,
					},
					{
						address: 'fe80::42:fff:fe33:6ad',
						netmask: 'ffff:ffff:ffff:ffff::',
						family: 'IPv6',
						mac: '02:42:0f:33:06:ad',
						scopeid: 3,
						internal: false,
					},
				],
				wlan0: [
					{
						address: '192.168.1.137',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '60:6d:c7:c6:44:3d',
						internal: false,
					},
					{
						address: '2605:9080:1103:3011:2dbe:35e3:1b5a:b99',
						netmask: 'ffff:ffff:ffff:ffff::',
						family: 'IPv6',
						mac: '60:6d:c7:c6:44:3d',
						scopeid: 0,
						internal: false,
					},
				],
				'resin-vpn': [
					{
						address: '10.10.2.14',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '01:43:1f:32:05:bd',
						internal: false,
					},
				],
			} as any),
		);

		// @ts-ignore
		after(() => os.networkInterfaces.restore());

		it('returns only the relevant IP addresses', () =>
			expect(network.getIPAddresses()).to.deep.equal(['192.168.1.137']));
	});

	it('checks VPN connection status', async () => {
		const statStub = stub(fs, 'lstat');
		const logStub = spy(Log, 'info');

		// Test when VPN is inactive
		statStub.rejects(); // Reject so we can't stat the vpn active file
		await expect(network.isVPNActive()).to.eventually.equal(false);
		expect(logStub.lastCall?.lastArg).to.equal(`VPN connection is not active.`);

		// Test when VPN is active
		statStub.resolves(); // Resolve so we can stat the vpn active file
		await expect(network.isVPNActive()).to.eventually.equal(true);
		expect(logStub.lastCall?.lastArg).to.equal(`VPN connection is active.`);

		// Restore stubs
		statStub.restore();
		logStub.restore();
	});
});
