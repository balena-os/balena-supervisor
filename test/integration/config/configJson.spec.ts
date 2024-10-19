import { expect } from 'chai';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';
import { promises as fs } from 'fs';

import ConfigJsonConfigBackend from '~/src/config/configJson';
import { schema, PROTECTED_FIELDS } from '~/src/config/schema';

describe('ConfigJsonConfigBackend', () => {
	const CONFIG_PATH = '/mnt/boot/config.json';
	let configJsonConfigBackend: ConfigJsonConfigBackend;

	beforeEach(() => {
		configJsonConfigBackend = new ConfigJsonConfigBackend(
			schema,
			PROTECTED_FIELDS,
		);
	});

	describe('getting and setting primitive values', () => {
		it('should get value for config.json key', async () => {
			await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

			await testfs.restore();
		});

		it('should set value for config.json key', async () => {
			await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.set({
				apiEndpoint: 'bar',
			});

			expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('bar');

			await testfs.restore();
		});

		// The following test cases may be unnecessary as they test cases where another party
		// writes to config.json directly (instead of through setting config vars on the API).
		it('should get cached value even if actual value has changed', async () => {
			await testfs({
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

			await testfs.restore();
		});

		it('should set value and refresh cache to equal new value', async () => {
			await testfs({
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
			expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

			await configJsonConfigBackend.set({
				apiEndpoint: 'baz',
			});

			expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('baz');

			await testfs.restore();
		});
	});

	describe('getting and setting protected "os" field', () => {
		const getOSConfigs = (
			powerMode: string | null,
			fanProfile: string | null,
		) => ({
			power: {
				foo: 'bar',
				...(powerMode && { mode: powerMode }),
			},
			fan: {
				bar: 'baz',
				...(fanProfile && { profile: fanProfile }),
			},
			baz: 'qux',
			// Other runtime OS configs as defined by https://docs.balena.io/reference/OS/configuration/#sample-configjson
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
		});

		let tfs: TestFs.Enabled;
		afterEach(async () => {
			await tfs.restore();
		});

		it('should get only managed values', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', 'cool'),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				power: {
					mode: 'high',
				},
				fan: {
					profile: 'cool',
				},
			});

			// Check that unmanaged fields are not overwritten
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', 'cool'),
				}),
			);
		});

		it('should get only managed values when power mode is not defined', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, 'cool'),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				fan: {
					profile: 'cool',
				},
			});
		});

		it('should get only managed values when fan profile is not defined', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', null),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				power: {
					mode: 'high',
				},
			});
		});

		it('should get only managed values when all managed values are not defined', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
			);
		});

		it('should set only managed values in a protected "os" field', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', 'cool'),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.set({
				os: {
					power: {
						mode: 'low',
					},
					fan: {
						profile: 'quiet',
					},
				},
			});

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				power: {
					mode: 'low',
				},
				fan: {
					profile: 'quiet',
				},
			});

			// Check that unmanaged fields are not overwritten
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('low', 'quiet'),
				}),
			);
		});

		it('should set only managed values while removing managed keys that are not in target', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', null),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				power: {
					mode: 'high',
				},
			});

			await configJsonConfigBackend.set({
				os: {
					fan: {
						profile: 'cool',
					},
				},
			});

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				fan: {
					profile: 'cool',
				},
			});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, 'cool'),
				}),
			);
		});

		it('should set only managed values without erroring when all target values are equal to current values', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', 'cool'),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.set({
				os: {
					power: {
						mode: 'high',
					},
					fan: {
						profile: 'cool',
					},
				},
			});

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				power: {
					mode: 'high',
				},
				fan: {
					profile: 'cool',
				},
			});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', 'cool'),
				}),
			);
		});

		it('should set only managed values without erroring when current value is undefined', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					uuid: 'bar',
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.set({
				os: {
					power: {
						mode: 'high',
					},
					fan: {
						profile: 'cool',
					},
				},
			});

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({
				power: {
					mode: 'high',
				},
				fan: {
					profile: 'cool',
				},
			});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					uuid: 'bar',
					os: {
						power: {
							mode: 'high',
						},
						fan: {
							profile: 'cool',
						},
					},
				}),
			);
		});

		it('should set only managed values to null (i.e. remove them) without erroring', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', 'cool'),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.set({
				os: {},
			});

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
			);
		});

		it('should set only managed values to null (i.e. remove them) without erroring when all current managed values are already null', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.set({
				os: {},
			});

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
			);
		});

		it('should remove only managed values', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs('high', 'cool'),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.remove('os');

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
			);
		});

		it('should remove only managed values and succeed if no managed values are set', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
				'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
			}).enable();

			await configJsonConfigBackend.remove('os');

			expect(await configJsonConfigBackend.get('os')).to.deep.equal({});

			// Check that config.json has the correct values
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					os: getOSConfigs(null, null),
				}),
			);
		});
	});
});
