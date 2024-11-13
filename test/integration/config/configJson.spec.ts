import { expect } from 'chai';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';
import { promises as fs } from 'fs';

import ConfigJsonConfigBackend from '~/src/config/configJson';
import { schema } from '~/src/config/schema';

describe('ConfigJsonConfigBackend', () => {
	const CONFIG_PATH = '/mnt/boot/config.json';
	const os = {
		power: {
			mode: 'high',
		},
		fan: {
			profile: 'cool',
		},
		network: {
			connectivity: {
				uri: 'https://api.balena-cloud.com/connectivity-check',
				interval: '300',
				response: 'optional value in the response',
			},
			wifi: {
				randomMacAddressScan: false,
			},
		},
		udevRules: {
			'56': 'ENV{ID_FS_LABEL_ENC}=="resin-root*", IMPORT{program}="resin_update_state_probe $devnode", SYMLINK+="disk/by-state/$env{RESIN_UPDATE_STATE}"',
			'64': 'ACTION!="add|change", GOTO="modeswitch_rules_end"\nKERNEL=="ttyACM*", ATTRS{idVendor}=="1546", ATTRS{idProduct}=="1146", TAG+="systemd", ENV{SYSTEMD_WANTS}="u-blox-switch@\'%E{DEVNAME}\'.service"\nLBEL="modeswitch_rules_end"\n',
		},
		sshKeys: [
			'ssh-rsa AAAAB3Nza...M2JB balena@macbook-pro',
			'ssh-rsa AAAAB3Nza...nFTQ balena@zenbook',
		],
	};
	let configJsonConfigBackend: ConfigJsonConfigBackend;
	let tfs: TestFs.Enabled;

	beforeEach(() => {
		configJsonConfigBackend = new ConfigJsonConfigBackend(schema);
	});

	afterEach(async () => {
		await tfs.restore();
	});

	it('should get primitive values for config.json key', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
				deviceId: 123,
				persistentLogging: true,
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');
		expect(await configJsonConfigBackend.get('deviceId')).to.equal(123);
		expect(await configJsonConfigBackend.get('persistentLogging')).to.equal(
			true,
		);
	});

	it('should get object values for config.json "os" key', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({
				os,
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		expect(await configJsonConfigBackend.get('os')).to.deep.equal(os);
	});

	it('should get object values for config.json "os" key while "os" is empty', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		expect(await configJsonConfigBackend.get('os')).to.be.undefined;
	});

	it('should set primitive values for config.json key', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
				deviceId: 123,
				persistentLogging: true,
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		await configJsonConfigBackend.set({
			apiEndpoint: 'bar',
			deviceId: 456,
			persistentLogging: false,
		});

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('bar');
		expect(await configJsonConfigBackend.get('deviceId')).to.equal(456);
		expect(await configJsonConfigBackend.get('persistentLogging')).to.equal(
			false,
		);
	});

	it('should set object values for config.json "os" key', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({
				os,
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		const newOs = {
			power: {
				mode: 'low',
			},
			network: {
				wifi: {
					randomMacAddressScan: true,
				},
			},
			udevRules: {
				'56': 'ENV{ID_FS_LABEL_ENC}=="resin-root*", IMPORT{program}="resin_update_state_probe $devnode", SYMLINK+="disk/by-state/$env{RESIN_UPDATE_STATE}"',
			},
			sshKeys: ['ssh-rsa AAAAB3Nza...M2JB balena@macbook-pro'],
		};

		await configJsonConfigBackend.set({
			os: newOs,
		});

		expect(await configJsonConfigBackend.get('os')).to.deep.equal(newOs);
	});

	it('should set object values for config.json "os" key while "os" is empty', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		await configJsonConfigBackend.set({
			os,
		});

		expect(await configJsonConfigBackend.get('os')).to.deep.equal(os);
	});

	// The following test cases may be unnecessary as they test cases where another party
	// writes to config.json directly (instead of through setting config vars on the API).
	it('should get cached value even if actual value has changed', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		// The cached value should be returned
		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		// Change the value in the file
		await fs.writeFile(
			CONFIG_PATH,
			JSON.stringify({
				apiEndpoint: 'bar',
			}),
		);

		// Unintended behavior: the cached value should not be overwritten
		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');
	});

	it('should set value and refresh cache to equal new value', async () => {
		tfs = await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		await fs.writeFile(
			CONFIG_PATH,
			JSON.stringify({
				apiEndpoint: 'bar',
			}),
		);

		// Unintended behavior: cached value should not have been updated
		// as the change was not written to config.json by the Supervisor
		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		await configJsonConfigBackend.set({
			apiEndpoint: 'baz',
		});

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('baz');
	});
});
