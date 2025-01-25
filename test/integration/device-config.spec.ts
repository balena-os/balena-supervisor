import { stripIndent } from 'common-tags';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { SinonStub, SinonSpy } from 'sinon';
import { stub, spy } from 'sinon';
import { expect } from 'chai';

import * as deviceConfig from '~/src/device-state/device-config';
import * as fsUtils from '~/lib/fs-utils';
import * as logger from '~/src/logging';
import { Extlinux } from '~/src/config/backends/extlinux';
import { ConfigTxt } from '~/src/config/backends/config-txt';
import { Odmdata } from '~/src/config/backends/odmdata';
import { ConfigFs } from '~/src/config/backends/config-fs';
import { SplashImage } from '~/src/config/backends/splash-image';
import { pathOnBoot, pathOnRoot } from '~/lib/host-utils';
import {
	configJsonPath as configJson,
	hostOSVersionPath as osRelease,
} from '~/src/lib/constants';

import { testfs } from 'mocha-pod';

const extlinuxBackend = new Extlinux();
const configTxtBackend = new ConfigTxt();
const odmdataBackend = new Odmdata();
const configFsBackend = new ConfigFs();
const splashImageBackend = new SplashImage();

// TODO: Since the getBootConfig method is simple enough
// these tests could probably be removed if each backend has its own
// test and the src/config/utils module is properly tested.
describe('device-config', () => {
	const configFsJson = pathOnBoot('configfs.json');
	const configTxt = pathOnBoot('config.txt');
	const deviceTypeJson = pathOnBoot('device-type.json');

	let logSpy: SinonSpy;

	before(async () => {
		logSpy = spy(logger, 'logSystemMessage');
	});

	after(() => {
		logSpy.restore();
	});

	afterEach(() => {
		logSpy.resetHistory();
	});

	describe('formatConfigKeys', () => {
		it('accepts RESIN_ and BALENA_ variables', async () => {
			return expect(
				deviceConfig.formatConfigKeys({
					FOO: 'bar', // should be removed
					BAR: 'baz', // should be removed
					RESIN_SUPERVISOR_LOCAL_MODE: 'false', // any device
					BALENA_SUPERVISOR_OVERRIDE_LOCK: 'false', // any device
					BALENA_SUPERVISOR_POLL_INTERVAL: '100', // any device
					RESIN_HOST_CONFIG_dtparam: 'i2c_arm=on","spi=on","audio=on', // config.txt backend
					RESIN_HOST_CONFIGFS_ssdt: 'spidev1.0', // configfs backend
					BALENA_HOST_EXTLINUX_isolcpus: '1,2,3', // extlinux backend
				}),
			).to.deep.equal({
				SUPERVISOR_LOCAL_MODE: 'false',
				SUPERVISOR_OVERRIDE_LOCK: 'false',
				SUPERVISOR_POLL_INTERVAL: '100',
				HOST_CONFIG_dtparam: 'i2c_arm=on","spi=on","audio=on',
				HOST_CONFIGFS_ssdt: 'spidev1.0',
				HOST_EXTLINUX_isolcpus: '1,2,3',
			});
		});
	});

	describe('getDefaults', () => {
		it('returns default configuration values', () => {
			const conf = deviceConfig.getDefaults();
			return expect(conf).to.deep.equal({
				HOST_FIREWALL_MODE: 'off',
				HOST_DISCOVERABILITY: 'true',
				SUPERVISOR_VPN_CONTROL: 'true',
				SUPERVISOR_POLL_INTERVAL: '900000',
				SUPERVISOR_LOCAL_MODE: 'false',
				SUPERVISOR_CONNECTIVITY_CHECK: 'true',
				SUPERVISOR_LOG_CONTROL: 'true',
				SUPERVISOR_DELTA: 'false',
				SUPERVISOR_DELTA_REQUEST_TIMEOUT: '59000',
				SUPERVISOR_DELTA_APPLY_TIMEOUT: '0',
				SUPERVISOR_DELTA_RETRY_COUNT: '30',
				SUPERVISOR_DELTA_RETRY_INTERVAL: '10000',
				SUPERVISOR_DELTA_VERSION: '2',
				SUPERVISOR_INSTANT_UPDATE_TRIGGER: 'true',
				SUPERVISOR_OVERRIDE_LOCK: 'false',
				SUPERVISOR_PERSISTENT_LOGGING: 'false',
				SUPERVISOR_HARDWARE_METRICS: 'true',
			});
		});
	});

	describe('config.txt', () => {
		const tFs = testfs({
			// This is only needed so config.get doesn't fail
			[configJson]: JSON.stringify({ deviceType: 'fincm3' }),
			[configTxt]: stripIndent`
					enable_uart=1
					dtparam=i2c_arm=on
					dtparam=spi=on
					disable_splash=1
					avoid_warnings=1
					dtparam=audio=on
					gpu_mem=16`,
			[osRelease]: stripIndent`
					PRETTY_NAME="balenaOS 2.88.5+rev1"
					META_BALENA_VERSION="2.88.5"
					VERSION="2.88.5+rev1"
					VARIANT_ID="dev"
			`,
			[deviceTypeJson]: JSON.stringify({
				slug: 'fincm3',
				arch: 'armv7hf',
			}),
		});

		beforeEach(async () => {
			await tFs.enable();
		});

		afterEach(async () => {
			// Reset the state of the fs after each test to
			// prevent tests leaking into each other
			await tFs.restore();
		});

		it('correctly parses a config.txt file', async () => {
			// Will try to parse /test/data/mnt/boot/config.txt
			await expect(
				deviceConfig.getBootConfig(configTxtBackend),
			).to.eventually.deep.equal({
				HOST_CONFIG_dtparam: '"i2c_arm=on","spi=on","audio=on"',
				HOST_CONFIG_enable_uart: '1',
				HOST_CONFIG_disable_splash: '1',
				HOST_CONFIG_avoid_warnings: '1',
				HOST_CONFIG_gpu_mem: '16',
			});

			// Update config.txt to include initramfs and array variables
			await fs.writeFile(
				configTxt,
				stripIndent`
					initramfs initramf.gz 0x00800000
					dtparam=i2c=on
					dtparam=audio=on
					dtoverlay=ads7846
					dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
					foobar=baz`,
			);

			await expect(
				deviceConfig.getBootConfig(configTxtBackend),
			).to.eventually.deep.equal({
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
				HOST_CONFIG_dtoverlay:
					'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'baz',
			});
		});

		it('does not allow setting forbidden keys', async () => {
			const current = {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
				HOST_CONFIG_dtoverlay:
					'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'baz',
			};
			// Create another target with only change being initramfs which is blacklisted
			const target = {
				...current,
				HOST_CONFIG_initramfs: 'initramf.gz 0x00810000',
			};

			expect(() =>
				// @ts-expect-error accessing private value
				deviceConfig.bootConfigChangeRequired(
					configTxtBackend,
					current,
					target,
				),
			).to.throw('Attempt to change blacklisted config value initramfs');

			// Check if logs were called
			expect(logSpy).to.be.calledOnce;
			expect(logSpy).to.be.calledWith(
				'Attempt to change blacklisted config value initramfs',
				{
					error: 'Attempt to change blacklisted config value initramfs',
				},
				'Apply boot config error',
			);
		});

		it('does not try to change config.txt if it should not change', async () => {
			const current = {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
				HOST_CONFIG_dtoverlay:
					'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'baz',
			};
			const target = {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
				HOST_CONFIG_dtoverlay:
					'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'baz',
			};

			expect(
				// @ts-expect-error accessing private value
				deviceConfig.bootConfigChangeRequired(
					configTxtBackend,
					current,
					target,
				),
			).to.equal(false);
			expect(logSpy).to.not.be.called;
		});

		it('writes the target config.txt', async () => {
			const current = {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
				HOST_CONFIG_dtoverlay:
					'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'baz',
			};
			const target = {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=off"',
				HOST_CONFIG_dtoverlay: '"lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'bat',
				HOST_CONFIG_foobaz: 'bar',
			};

			expect(
				deviceConfig.bootConfigChangeRequired(
					configTxtBackend,
					current,
					target,
					'fincm3',
				),
			).to.equal(true);

			await deviceConfig.setBootConfig(configTxtBackend, target);
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(await fs.readFile(configTxt, 'utf-8')).to.equal(
				stripIndent`
					initramfs initramf.gz 0x00800000
					dtparam=i2c=on
					dtparam=audio=off
					foobar=bat
					foobaz=bar
					dtoverlay=lirc-rpi
					dtparam=gpio_out_pin=17
					dtparam=gpio_in_pin=13
					dtoverlay=balena-fin
				` + '\n', // add newline because stripIndent trims last newline
			);
		});

		it('ensures required fields are written to config.txt', async () => {
			const current = {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
				HOST_CONFIG_dtoverlay:
					'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'baz',
			};
			const target = {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=off"',
				HOST_CONFIG_dtoverlay: '"lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'bat',
				HOST_CONFIG_foobaz: 'bar',
			};

			expect(
				// @ts-expect-error accessing private value
				deviceConfig.bootConfigChangeRequired(
					configTxtBackend,
					current,
					target,
				),
			).to.equal(true);

			await deviceConfig.setBootConfig(configTxtBackend, target);
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(await fs.readFile(configTxt, 'utf-8')).to.equal(
				stripIndent`
					initramfs initramf.gz 0x00800000
					dtparam=i2c=on
					dtparam=audio=off
					foobar=bat
					foobaz=bar
					dtoverlay=lirc-rpi
					dtparam=gpio_out_pin=17
					dtparam=gpio_in_pin=13
					dtoverlay=balena-fin
				` + '\n', // add newline because stripIndent trims last newline
			);
		});
	});

	describe('extlinux', () => {
		const extlinuxConf = pathOnBoot('extlinux/extlinux.conf');

		const tFs = testfs({
			// This is only needed so config.get doesn't fail
			[configJson]: JSON.stringify({}),
			[osRelease]: stripIndent`
					PRETTY_NAME="balenaOS 2.88.5+rev1"
					META_BALENA_VERSION="2.88.5"
					VERSION="2.88.5+rev1"
					VARIANT_ID="dev"
				`,
			[deviceTypeJson]: JSON.stringify({
				slug: 'fincm3',
				arch: 'armv7hf',
			}),
			[extlinuxConf]: stripIndent`
					DEFAULT primary
					TIMEOUT 30
					MENU TITLE Boot Options
					LABEL primary
					MENU LABEL primary Image
					LINUX /Image
					APPEND \${cbootargs} \${resin_kernel_root} ro rootwait
				`,
		});

		beforeEach(async () => {
			await tFs.enable();
		});

		afterEach(async () => {
			// Reset the state of the fs after each test to
			// prevent tests leaking into each other
			await tFs.restore();
		});

		it('should correctly write to extlinux.conf files', async () => {
			const target = {
				HOST_EXTLINUX_isolcpus: '2',
				HOST_EXTLINUX_fdt: '/boot/mycustomdtb.dtb',
			};

			await deviceConfig.setBootConfig(extlinuxBackend, target);
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(await fs.readFile(extlinuxConf, 'utf-8')).to.equal(
				stripIndent`
					DEFAULT primary
					TIMEOUT 30
					MENU TITLE Boot Options
					LABEL primary
					MENU LABEL primary Image
					LINUX /Image
					APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=2
					FDT /boot/mycustomdtb.dtb
				` + '\n', // add newline because stripIndent trims last newline
			);
		});
	});

	describe('Balena fin', () => {
		it('should always add the balena-fin dtoverlay', () => {
			expect(configTxtBackend.ensureRequiredConfig('fincm3', {})).to.deep.equal(
				{
					dtoverlay: ['balena-fin'],
				},
			);

			expect(
				configTxtBackend.ensureRequiredConfig('fincm3', {
					test: '123',
					test2: ['123'],
					test3: ['123', '234'],
				}),
			).to.deep.equal({
				test: '123',
				test2: ['123'],
				test3: ['123', '234'],
				dtoverlay: ['balena-fin'],
			});
			expect(
				configTxtBackend.ensureRequiredConfig('fincm3', {
					dtoverlay: 'test',
				}),
			).to.deep.equal({ dtoverlay: ['test', 'balena-fin'] });
			expect(
				configTxtBackend.ensureRequiredConfig('fincm3', {
					dtoverlay: ['test'],
				}),
			).to.deep.equal({ dtoverlay: ['test', 'balena-fin'] });
		});

		it('should not cause a config change when the cloud does not specify the balena-fin overlay', () => {
			expect(
				deviceConfig.bootConfigChangeRequired(
					configTxtBackend,
					{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: '"test"' },
					'fincm3',
				),
			).to.equal(false);

			expect(
				deviceConfig.bootConfigChangeRequired(
					configTxtBackend,
					{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: 'test' },
					'fincm3',
				),
			).to.equal(false);

			expect(
				deviceConfig.bootConfigChangeRequired(
					configTxtBackend,
					{ HOST_CONFIG_dtoverlay: '"test","test2","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: '"test","test2"' },
					'fincm3',
				),
			).to.equal(false);
		});
	});

	describe('ODMDATA', () => {
		it('requires change when target is different', () => {
			expect(
				deviceConfig.bootConfigChangeRequired(
					odmdataBackend,
					{ HOST_ODMDATA_configuration: '2' },
					{ HOST_ODMDATA_configuration: '5' },
					'jetson-tx2',
				),
			).to.equal(true);
		});
		it('requires change when no target is set', () => {
			expect(
				deviceConfig.bootConfigChangeRequired(
					odmdataBackend,
					{ HOST_ODMDATA_configuration: '2' },
					{},
					'jetson-tx2',
				),
			).to.equal(false);
		});
	});

	describe('config-fs', () => {
		const acpiTables = pathOnRoot('boot/acpi-tables');
		const sysKernelAcpiTable = pathOnRoot('sys/kernel/config/acpi/table');

		const tFs = testfs({
			// This is only needed so config.get doesn't fail
			[configJson]: JSON.stringify({}),
			[osRelease]: stripIndent`
					PRETTY_NAME="balenaOS 2.88.5+rev1"
					META_BALENA_VERSION="2.88.5"
					VERSION="2.88.5+rev1"
					VARIANT_ID="dev"
				`,
			[configFsJson]: JSON.stringify({
				ssdt: ['spidev1.1'],
			}),

			[deviceTypeJson]: JSON.stringify({
				slug: 'fincm3',
				arch: 'armv7hf',
			}),
			[acpiTables]: {
				'spidev1.0.aml': '',
				'spidev1.1.aml': '',
			},
			[sysKernelAcpiTable]: {
				// Add necessary files to avoid the module reporting an error
				'spidev1.1': {
					oem_id: '',
					oem_table_id: '',
					oem_revision: '',
				},
			},
		});

		beforeEach(async () => {
			await tFs.enable();
		});

		afterEach(async () => {
			// Reset the state of the fs after each test to
			// prevent tests leaking into each other
			await tFs.restore();
		});

		it('should correctly write to configfs.json files', async () => {
			const current = {};
			const target = {
				HOST_CONFIGFS_ssdt: 'spidev1.0',
			};

			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					current,
					target,
					'up-board',
				),
			).to.equal(true);

			await deviceConfig.setBootConfig(configFsBackend, target);
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(await fs.readFile(configFsJson, 'utf-8')).to.equal(
				'{"ssdt":["spidev1.0"]}',
			);
		});

		// This test is skipped because it depends on internal details of the config-fs
		// backend. We need to refactor that module to make this more testable
		// properly
		it.skip('should correctly load the configfs.json file', async () => {
			await configFsBackend.initialise();

			stub(fsUtils, 'exec').resolves();
			await configFsBackend.initialise();

			// TODO: unfortunately there is no way to test initialization without stubbing
			// modprobe cannot be replaced by something else and the up-board modules
			// will not be present within the container environment. OS tests need
			// to check that applying configurations actually succeds
			expect(fsUtils.exec).to.be.calledWith('modprobe acpi_configfs');

			// If the module performs this call, it's because all the prior checks succeeded
			expect(fsUtils.exec).to.be.calledWith(
				'cat /mnt/root/boot/acpi-tables/spidev1.1.aml > /mnt/root/sys/kernel/config/acpi/table/spidev1.1/aml',
			);

			// Restore stubs
			(fsUtils.exec as SinonStub).restore();
		});

		it('requires change when target is different', () => {
			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					{ HOST_CONFIGFS_ssdt: '' },
					{ HOST_CONFIGFS_ssdt: 'spidev1.0' },
					'up-board',
				),
			).to.equal(true);
			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					{ HOST_CONFIGFS_ssdt: '' },
					{ HOST_CONFIGFS_ssdt: '"spidev1.0"' },
					'up-board',
				),
			).to.equal(true);
			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					{ HOST_CONFIGFS_ssdt: '"spidev1.0"' },
					{ HOST_CONFIGFS_ssdt: '"spidev1.0","spidev1.1"' },
					'up-board',
				),
			).to.equal(true);
		});

		it('should not report change when target is equal to current', () => {
			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					{ HOST_CONFIGFS_ssdt: '' },
					{ HOST_CONFIGFS_ssdt: '' },
					'up-board',
				),
			).to.equal(false);
			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					{ HOST_CONFIGFS_ssdt: 'spidev1.0' },
					{ HOST_CONFIGFS_ssdt: 'spidev1.0' },
					'up-board',
				),
			).to.equal(false);
			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					{ HOST_CONFIGFS_ssdt: 'spidev1.0' },
					{ HOST_CONFIGFS_ssdt: '"spidev1.0"' },
					'up-board',
				),
			).to.equal(false);
			expect(
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					{ HOST_CONFIGFS_ssdt: '"spidev1.0"' },
					{ HOST_CONFIGFS_ssdt: 'spidev1.0' },
					'up-board',
				),
			).to.equal(false);
		});
	});

	describe('splash config', () => {
		const defaultLogo =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/wQDLA+84AAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
		const png =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/TQBcNTh/AAAAAXRSTlPM0jRW/QAAAApJREFUeJxjYgAAAAYAAzY3fKgAAAAASUVORK5CYII=';
		const uri = `data:image/png;base64,${png}`;

		const splash = pathOnBoot('splash');

		const mockFs = testfs(
			{
				// This is only needed so config.get doesn't fail
				[configJson]: JSON.stringify({}),
				[osRelease]: stripIndent`
					PRETTY_NAME="balenaOS 2.88.5+rev1"
					META_BALENA_VERSION="2.88.5"
					VERSION="2.88.5+rev1"
					VARIANT_ID="dev"
				`,
				[deviceTypeJson]: JSON.stringify({
					slug: 'raspberrypi4-64',
					arch: 'aarch64',
				}),
				[splash]: {
					dummy: '', // to ensure the directory is created
				},
			},
			{ cleanup: [`${splash}/*.png`] },
		);

		beforeEach(async () => {
			await mockFs.enable();
		});

		afterEach(async () => {
			await mockFs.restore();
		});

		it('should correctly write to resin-logo.png', async () => {
			// Devices with balenaOS < 2.51 use resin-logo.png
			// Devices with balenaOS >= 2.51 use balena-logo.png
			const tTfs = await testfs({
				[splash]: {
					'resin-logo.png': Buffer.from(png, 'base64'),
				},
			}).enable();

			const target = {
				HOST_SPLASH_image: png,
			};

			await deviceConfig.setBootConfig(splashImageBackend, target);

			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(
				await fs.readFile(path.join(splash, 'resin-logo.png'), 'base64'),
			).to.equal(png);

			await tTfs.restore();
		});

		it('should correctly write to balena-logo.png', async () => {
			// Devices with balenaOS >= 2.51 use balena-logo.png
			const tTfs = await testfs({
				[splash]: {
					'balena-logo.png': Buffer.from(png, 'base64'),
				},
			}).enable();

			const target = {
				HOST_SPLASH_image: png,
			};

			await deviceConfig.setBootConfig(splashImageBackend, target);

			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(
				await fs.readFile(path.join(splash, 'balena-logo.png'), 'base64'),
			).to.equal(png);

			await tTfs.restore();
		});

		it('should correctly write to balena-logo.png if no default logo is found', async () => {
			// Devices with balenaOS >= 2.51 use balena-logo.png
			const current = {};
			const target = {
				HOST_SPLASH_image: png,
			};

			// This should work with every device type, but testing on a couple
			// of options
			expect(
				deviceConfig.bootConfigChangeRequired(
					splashImageBackend,
					current,
					target,
					'raspberrypi3',
				),
			).to.equal(true);

			await deviceConfig.setBootConfig(splashImageBackend, target);

			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(
				await fs.readFile(path.join(splash, 'balena-logo.png'), 'base64'),
			).to.equal(png);
		});

		it('should correctly read the splash logo if different from the default', async () => {
			const tTfs = await testfs({
				[splash]: {
					'balena-logo.png': Buffer.from(png, 'base64'),
					'balena-logo-default.png': Buffer.from(defaultLogo, 'base64'),
				},
			}).enable();

			expect(
				await deviceConfig.getBootConfig(splashImageBackend),
			).to.deep.equal({
				HOST_SPLASH_image: uri,
			});
			await tTfs.restore();
		});
	});

	describe('getRequiredSteps', () => {
		const splash = pathOnBoot('splash/balena-logo.png');

		const tFs = testfs({
			// This is only needed so config.get doesn't fail
			[configJson]: JSON.stringify({}),
			[configTxt]: stripIndent`
					enable_uart=true
				`,
			[osRelease]: stripIndent`
					PRETTY_NAME="balenaOS 2.88.5+rev1"
					META_BALENA_VERSION="2.88.5"
					VERSION="2.88.5+rev1"
					VARIANT_ID="dev"
				`,
			[deviceTypeJson]: JSON.stringify({
				slug: 'raspberrypi4-64',
				arch: 'aarch64',
			}),
			[splash]: Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
				'base64',
			),
		});

		beforeEach(async () => {
			await tFs.enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('returns required steps to config.json first if any', async () => {
			const steps = await deviceConfig.getRequiredSteps(
				{
					local: {
						config: {
							SUPERVISOR_POLL_INTERVAL: 900000,
							HOST_CONFIG_enable_uart: true,
						},
					},
				} as any,
				{
					local: {
						config: {
							SUPERVISOR_POLL_INTERVAL: 600000,
							HOST_CONFIG_enable_uart: false,
						},
					},
				} as any,
			);
			expect(steps.map((s) => s.action)).to.have.members([
				// No reboot is required by this config change
				'changeConfig',
				'noop', // The noop has to be here since there are also changes from config backends
			]);
		});

		it('sets the rebooot breadcrumb for config steps that require a reboot', async () => {
			const steps = await deviceConfig.getRequiredSteps(
				{
					local: {
						config: {
							SUPERVISOR_POLL_INTERVAL: 900000,
							SUPERVISOR_PERSISTENT_LOGGING: false,
						},
					},
				} as any,
				{
					local: {
						config: {
							SUPERVISOR_POLL_INTERVAL: 600000,
							SUPERVISOR_PERSISTENT_LOGGING: true,
						},
					},
				} as any,
			);
			expect(steps.map((s) => s.action)).to.have.members([
				'setRebootBreadcrumb',
				'changeConfig',
				'noop',
			]);
		});

		it('returns required steps for backends if no steps are required for config.json', async () => {
			const steps = await deviceConfig.getRequiredSteps(
				{
					local: {
						config: {
							SUPERVISOR_POLL_INTERVAL: 900000,
							SUPERVISOR_PERSISTENT_LOGGING: true,
							HOST_CONFIG_enable_uart: true,
						},
					},
				} as any,
				{
					local: {
						config: {
							SUPERVISOR_POLL_INTERVAL: 900000,
							SUPERVISOR_PERSISTENT_LOGGING: true,
							HOST_CONFIG_enable_uart: false,
						},
					},
				} as any,
			);
			expect(steps.map((s) => s.action)).to.have.members([
				'setRebootBreadcrumb',
				'setBootConfig',
			]);
		});
	});
});
