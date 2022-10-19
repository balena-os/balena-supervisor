import * as os from 'os';
import { stub } from 'sinon';

import { expect } from 'chai';
import * as network from '~/src/network';

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
				eth0: [
					{
						address: 'fe80::9992:76e3:c2e1:8a02',
						netmask: 'ffff:ffff:ffff:ffff::',
						family: 'IPv6',
						mac: '58:6d:c7:c6:44:3d',
						scopeid: 9,
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

		// @ts-expect-error
		after(() => os.networkInterfaces.restore());

		it('returns only the relevant IP addresses', () =>
			expect(network.getIPAddresses()).to.deep.equal([
				'192.168.1.137',
				'2605:9080:1103:3011:2dbe:35e3:1b5a:b99',
			]));
	});
});
