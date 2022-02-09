import { stripIndent } from 'common-tags';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SinonStub, stub, spy, SinonSpy } from 'sinon';
import { expect } from 'chai';

import * as deviceConfig from '../src/device-config';
import * as fsUtils from '../src/lib/fs-utils';
import * as logger from '../src/logger';
import { Extlinux } from '../src/config/backends/extlinux';
import { ConfigTxt } from '../src/config/backends/config-txt';
import { Odmdata } from '../src/config/backends/odmdata';
import { ConfigFs } from '../src/config/backends/config-fs';
import { SplashImage } from '../src/config/backends/splash-image';
import * as constants from '../src/lib/constants';
import * as config from '../src/config';

import prepare = require('./lib/prepare');
import mock = require('mock-fs');

const extlinuxBackend = new Extlinux();
const configTxtBackend = new ConfigTxt();
const odmdataBackend = new Odmdata();
const configFsBackend = new ConfigFs();
const splashImageBackend = new SplashImage();

// TODO: Since the getBootConfig method is simple enough
// these tests could probably be removed if each backend has its own
// test and the src/config/utils module is properly tested.
describe('Device Backend Config', () => {
	let logSpy: SinonSpy;

	before(async () => {
		logSpy = spy(logger, 'logSystemMessage');
		await prepare();
	});

	after(() => {
		logSpy.restore();
	});

	afterEach(() => {
		logSpy.resetHistory();
	});

	it('correctly parses a config.txt file', async () => {
		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(
			// @ts-ignore accessing private value
			deviceConfig.getBootConfig(configTxtBackend),
		).to.eventually.deep.equal({
			HOST_CONFIG_dtparam: '"i2c_arm=on","spi=on","audio=on"',
			HOST_CONFIG_enable_uart: '1',
			HOST_CONFIG_disable_splash: '1',
			HOST_CONFIG_avoid_warnings: '1',
			HOST_CONFIG_gpu_mem: '16',
		});

		// Stub readFile to return a config that has initramfs and array variables
		stub(fs, 'readFile').resolves(stripIndent`
			initramfs initramf.gz 0x00800000
			dtparam=i2c=on
			dtparam=audio=on
			dtoverlay=ads7846
			dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
			foobar=baz
		`);

		await expect(
			// @ts-ignore accessing private value
			deviceConfig.getBootConfig(configTxtBackend),
		).to.eventually.deep.equal({
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
			HOST_CONFIG_dtoverlay:
				'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
			HOST_CONFIG_foobar: 'baz',
		});

		// Restore stub
		(fs.readFile as SinonStub).restore();
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
			// @ts-ignore accessing private value
			deviceConfig.bootConfigChangeRequired(configTxtBackend, current, target),
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
			// @ts-ignore accessing private value
			deviceConfig.bootConfigChangeRequired(configTxtBackend, current, target),
		).to.equal(false);
		expect(logSpy).to.not.be.called;
	});

	it('writes the target config.txt', async () => {
		stub(fsUtils, 'writeFileAtomic').resolves();
		stub(fsUtils, 'exec').resolves();
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
			// @ts-ignore accessing private value
			deviceConfig.bootConfigChangeRequired(configTxtBackend, current, target),
		).to.equal(true);

		// @ts-ignore accessing private value
		await deviceConfig.setBootConfig(configTxtBackend, target);
		expect(fsUtils.exec).to.be.calledOnce;
		expect(logSpy).to.be.calledTwice;
		expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
		expect(fsUtils.writeFileAtomic).to.be.calledWith(
			'./test/data/mnt/boot/config.txt',
			stripIndent`
				initramfs initramf.gz 0x00800000
				dtparam=i2c=on
				dtparam=audio=off
				dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
				foobar=bat
				foobaz=bar
			` + '\n', // add newline because stripIndent trims last newline
		);

		// Restore stubs
		(fsUtils.writeFileAtomic as SinonStub).restore();
		(fsUtils.exec as SinonStub).restore();
	});

	it('ensures required fields are written to config.txt', async () => {
		stub(fsUtils, 'writeFileAtomic').resolves();
		stub(fsUtils, 'exec').resolves();
		stub(config, 'get').withArgs('deviceType').resolves('fincm3');
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
			// @ts-ignore accessing private value
			deviceConfig.bootConfigChangeRequired(configTxtBackend, current, target),
		).to.equal(true);

		// @ts-ignore accessing private value
		await deviceConfig.setBootConfig(configTxtBackend, target);
		expect(fsUtils.exec).to.be.calledOnce;
		expect(logSpy).to.be.calledTwice;
		expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
		expect(fsUtils.writeFileAtomic).to.be.calledWith(
			'./test/data/mnt/boot/config.txt',
			stripIndent`
				initramfs initramf.gz 0x00800000
				dtparam=i2c=on
				dtparam=audio=off
				dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
				dtoverlay=balena-fin
				foobar=bat
				foobaz=bar
			` + '\n', // add newline because stripIndent trims last newline
		);

		// Restore stubs
		(fsUtils.writeFileAtomic as SinonStub).restore();
		(fsUtils.exec as SinonStub).restore();
		(config.get as SinonStub).restore();
	});

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

	describe('Extlinux files', () => {
		it('should correctly write to extlinux.conf files', async () => {
			stub(fsUtils, 'writeFileAtomic').resolves();
			stub(fsUtils, 'exec').resolves();

			const current = {};
			const target = {
				HOST_EXTLINUX_isolcpus: '2',
				HOST_EXTLINUX_fdt: '/boot/mycustomdtb.dtb',
			};

			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(extlinuxBackend, current, target),
			).to.equal(true);

			// @ts-ignore accessing private value
			await deviceConfig.setBootConfig(extlinuxBackend, target);
			expect(fsUtils.exec).to.be.calledOnce;
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(fsUtils.writeFileAtomic).to.be.calledWith(
				'./test/data/mnt/boot/extlinux/extlinux.conf',
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

			// Restore stubs
			(fsUtils.writeFileAtomic as SinonStub).restore();
			(fsUtils.exec as SinonStub).restore();
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

	describe('ConfigFS files', () => {
		it('should correctly write to configfs.json files', async () => {
			stub(fsUtils, 'writeFileAtomic').resolves();
			stub(fsUtils, 'exec').resolves();

			const current = {};
			const target = {
				HOST_CONFIGFS_ssdt: 'spidev1.0',
			};

			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(
					configFsBackend,
					current,
					target,
					'up-board',
				),
			).to.equal(true);

			// @ts-ignore accessing private value
			await deviceConfig.setBootConfig(configFsBackend, target);
			expect(fsUtils.exec).to.be.calledOnce;
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(fsUtils.writeFileAtomic).to.be.calledWith(
				'test/data/mnt/boot/configfs.json',
				'{"ssdt":["spidev1.0"]}',
			);

			// Restore stubs
			(fsUtils.writeFileAtomic as SinonStub).restore();
			(fsUtils.exec as SinonStub).restore();
		});

		it('should correctly load the configfs.json file', async () => {
			stub(fsUtils, 'exec').resolves();
			stub(fsUtils, 'writeFileAtomic').resolves();
			stub(fsUtils, 'exists').resolves(true);
			stub(fs, 'mkdir').resolves();
			stub(fs, 'readdir').resolves([]);
			stub(fs, 'readFile').callsFake((file) => {
				if (file === 'test/data/mnt/boot/configfs.json') {
					return Promise.resolve(
						JSON.stringify({
							ssdt: ['spidev1.1'],
						}),
					);
				}
				return Promise.resolve('');
			});

			await configFsBackend.initialise();
			expect(fsUtils.exec).to.be.calledWith('modprobe acpi_configfs');
			expect(fsUtils.exec).to.be.calledWith(
				`mount -t vfat -o remount,rw ${constants.bootBlockDevice} ./test/data/mnt/boot`,
			);
			expect(fsUtils.exec).to.be.calledWith(
				'cat test/data/boot/acpi-tables/spidev1.1.aml > test/data/sys/kernel/config/acpi/table/spidev1.1/aml',
			);
			expect((fsUtils.exists as SinonSpy).callCount).to.equal(2);
			expect((fs.readFile as SinonSpy).callCount).to.equal(4);

			// Restore stubs
			(fsUtils.writeFileAtomic as SinonStub).restore();
			(fsUtils.exec as SinonStub).restore();
			(fsUtils.exists as SinonStub).restore();
			(fs.mkdir as SinonStub).restore();
			(fs.readdir as SinonStub).restore();
			(fs.readFile as SinonStub).restore();
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

	describe('Boot splash image', () => {
		const defaultLogo =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/wQDLA+84AAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
		const png =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/TQBcNTh/AAAAAXRSTlPM0jRW/QAAAApJREFUeJxjYgAAAAYAAzY3fKgAAAAASUVORK5CYII=';
		const uri = `data:image/png;base64,${png}`;

		beforeEach(() => {
			// Setup stubs
			stub(fsUtils, 'writeFileAtomic').resolves();
			stub(fsUtils, 'exec').resolves();
		});

		afterEach(() => {
			// Restore stubs
			(fsUtils.writeFileAtomic as SinonStub).restore();
			(fsUtils.exec as SinonStub).restore();
		});

		it('should correctly write to resin-logo.png', async () => {
			// Devices with balenaOS < 2.51 use resin-logo.png
			stub(fs, 'readdir').resolves(['resin-logo.png'] as any);

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
					'fincm3',
				),
			).to.equal(true);
			await deviceConfig.setBootConfig(splashImageBackend, target);

			expect(fsUtils.exec).to.be.calledOnce;
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(fsUtils.writeFileAtomic).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/resin-logo.png',
			);

			// restore the stub
			(fs.readdir as SinonStub).restore();
		});

		it('should correctly write to balena-logo.png', async () => {
			// Devices with balenaOS >= 2.51 use balena-logo.png
			stub(fs, 'readdir').resolves(['balena-logo.png'] as any);

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
					'raspberrypi4-64',
				),
			).to.equal(true);

			await deviceConfig.setBootConfig(splashImageBackend, target);

			expect(fsUtils.exec).to.be.calledOnce;
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(fsUtils.writeFileAtomic).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
			);

			// restore the stub
			(fs.readdir as SinonStub).restore();
		});

		it('should correctly write to balena-logo.png if no default logo is found', async () => {
			// Devices with balenaOS >= 2.51 use balena-logo.png
			stub(fs, 'readdir').resolves([]);

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

			expect(fsUtils.exec).to.be.calledOnce;
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
			expect(fsUtils.writeFileAtomic).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
			);

			// restore the stub
			(fs.readdir as SinonStub).restore();
		});

		it('should correctly read the splash logo if different from the default', async () => {
			stub(fs, 'readdir').resolves(['balena-logo.png'] as any);

			const readFileStub: SinonStub = stub(fs, 'readFile').resolves(
				Buffer.from(png, 'base64') as any,
			);
			readFileStub
				.withArgs('test/data/mnt/boot/splash/balena-logo-default.png')
				.resolves(Buffer.from(defaultLogo, 'base64') as any);

			expect(
				await deviceConfig.getBootConfig(splashImageBackend),
			).to.deep.equal({
				HOST_SPLASH_image: uri,
			});
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo.png',
			);

			// Restore stubs
			(fs.readdir as SinonStub).restore();
			(fs.readFile as SinonStub).restore();
			readFileStub.restore();
		});
	});
});

describe('getRequiredSteps', () => {
	const bootMountPoint = path.join(
		constants.rootMountPoint,
		constants.bootMountPoint,
	);
	const configJson = 'test/data/config.json';
	const configTxt = path.join(bootMountPoint, 'config.txt');
	const deviceTypeJson = path.join(bootMountPoint, 'device-type.json');
	const osRelease = path.join(constants.rootMountPoint, '/etc/os-release');
	const splash = path.join(bootMountPoint, 'splash/balena-logo.png');

	// TODO: something like this could be done as a fixture instead of
	// doing the file initialisation on 00-init.ts
	const mockFs = () => {
		mock({
			// This is only needed so config.get doesn't fail
			[configJson]: JSON.stringify({}),
			[configTxt]: stripIndent`
				enable_uart=true
			`,
			[osRelease]: stripIndent`
				PRETTY_NAME="balenaOS 2.88.5+rev1"
				META_BALENA_VERSION="2.88.5"
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
	};

	const unmockFs = () => {
		mock.restore();
	};

	before(() => {
		mockFs();

		// TODO: remove this once the remount on backend.ts is no longer
		// necessary
		stub(fsUtils, 'exec');
	});

	after(() => {
		unmockFs();
		(fsUtils.exec as SinonStub).restore();
	});

	it('returns required steps to config.json first if any', async () => {
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
						SUPERVISOR_POLL_INTERVAL: 600000,
						SUPERVISOR_PERSISTENT_LOGGING: false,
						HOST_CONFIG_enable_uart: false,
					},
				},
			} as any,
		);
		expect(steps.map((s) => s.action)).to.have.members([
			'changeConfig',
			'noop', // The noop has to be here since there are also changes from config backends
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
		expect(steps.map((s) => s.action)).to.have.members(['setBootConfig']);
	});
});
