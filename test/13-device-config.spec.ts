import { Promise } from 'bluebird';
import { stripIndent } from 'common-tags';
import { child_process, fs } from 'mz';
import { SinonSpy, SinonStub, stub, spy } from 'sinon';

import { expect } from './lib/chai-config';
import * as config from '../src/config';
import { DeviceConfig } from '../src/device-config';
import * as fsUtils from '../src/lib/fs-utils';
import * as logger from '../src/logger';
import { ExtlinuxConfigBackend } from '../src/config/backends/extlinux';
import { RPiConfigBackend } from '../src/config/backends/raspberry-pi';
import { DeviceConfigBackend } from '../src/config/backends/backend';
import prepare = require('./lib/prepare');

const extlinuxBackend = new ExtlinuxConfigBackend();
const rpiConfigBackend = new RPiConfigBackend();

describe('Device Backend Config', () => {
	let deviceConfig: DeviceConfig;
	const logSpy = spy(logger, 'logSystemMessage');

	before(async () => {
		await prepare();
		deviceConfig = new DeviceConfig();
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
			deviceConfig.getBootConfig(rpiConfigBackend),
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
			deviceConfig.getBootConfig(rpiConfigBackend),
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
			deviceConfig.bootConfigChangeRequired(rpiConfigBackend, current, target),
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
			deviceConfig.bootConfigChangeRequired(rpiConfigBackend, current, target),
		).to.equal(false);
		expect(logSpy).to.not.be.called;
	});

	it('writes the target config.txt', async () => {
		stub(fsUtils, 'writeFileAtomic').resolves();
		stub(child_process, 'exec').resolves();
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
			deviceConfig.bootConfigChangeRequired(rpiConfigBackend, current, target),
		).to.equal(true);

		// @ts-ignore accessing private value
		await deviceConfig.setBootConfig(rpiConfigBackend, target);
		expect(child_process.exec).to.be.calledOnce;
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
		(child_process.exec as SinonStub).restore();
	});

	it('accepts RESIN_ and BALENA_ variables', async () => {
		return expect(
			deviceConfig.formatConfigKeys({
				FOO: 'bar',
				BAR: 'baz',
				RESIN_HOST_CONFIG_foo: 'foobaz',
				BALENA_HOST_CONFIG_foo: 'foobar',
				RESIN_HOST_CONFIG_other: 'val',
				BALENA_HOST_CONFIG_baz: 'bad',
				BALENA_SUPERVISOR_POLL_INTERVAL: '100',
			}),
		).to.eventually.deep.equal({
			HOST_CONFIG_foo: 'foobar',
			HOST_CONFIG_other: 'val',
			HOST_CONFIG_baz: 'bad',
			SUPERVISOR_POLL_INTERVAL: '100',
		});
	});

	it('returns default configuration values', () => {
		const conf = deviceConfig.getDefaults();
		return expect(conf).to.deep.equal({
			HOST_FIREWALL_MODE: 'off',
			SUPERVISOR_VPN_CONTROL: 'true',
			SUPERVISOR_POLL_INTERVAL: '60000',
			SUPERVISOR_LOCAL_MODE: 'false',
			SUPERVISOR_CONNECTIVITY_CHECK: 'true',
			SUPERVISOR_LOG_CONTROL: 'true',
			SUPERVISOR_DELTA: 'false',
			SUPERVISOR_DELTA_REQUEST_TIMEOUT: '30000',
			SUPERVISOR_DELTA_APPLY_TIMEOUT: '0',
			SUPERVISOR_DELTA_RETRY_COUNT: '30',
			SUPERVISOR_DELTA_RETRY_INTERVAL: '10000',
			SUPERVISOR_DELTA_VERSION: '2',
			SUPERVISOR_INSTANT_UPDATE_TRIGGER: 'true',
			SUPERVISOR_OVERRIDE_LOCK: 'false',
			SUPERVISOR_PERSISTENT_LOGGING: 'false',
		});
	});

	describe('Extlinux files', () => {
		it('should correctly write to extlinux.conf files', async () => {
			stub(fsUtils, 'writeFileAtomic').resolves();
			stub(child_process, 'exec').resolves();

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
			expect(child_process.exec).to.be.calledOnce;
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
			(child_process.exec as SinonStub).restore();
		});
	});

	describe('Balena fin', () => {
		it('should always add the balena-fin dtoverlay', () => {
			expect(
				(DeviceConfig as any).ensureRequiredOverlay('fincm3', {}),
			).to.deep.equal({ dtoverlay: ['balena-fin'] });
			expect(
				(DeviceConfig as any).ensureRequiredOverlay('fincm3', {
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
				(DeviceConfig as any).ensureRequiredOverlay('fincm3', {
					dtoverlay: 'test',
				}),
			).to.deep.equal({ dtoverlay: ['test', 'balena-fin'] });
			expect(
				(DeviceConfig as any).ensureRequiredOverlay('fincm3', {
					dtoverlay: ['test'],
				}),
			).to.deep.equal({ dtoverlay: ['test', 'balena-fin'] });
		});

		it('should not cause a config change when the cloud does not specify the balena-fin overlay', () => {
			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: '"test"' },
					'fincm3',
				),
			).to.equal(false);

			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: 'test' },
					'fincm3',
				),
			).to.equal(false);

			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","test2","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: '"test","test2"' },
					'fincm3',
				),
			).to.equal(false);
		});
	});

	describe('Raspberry pi4', () => {
		it('should always add the vc4-fkms-v3d dtoverlay', () => {
			expect(
				(DeviceConfig as any).ensureRequiredOverlay('raspberrypi4-64', {}),
			).to.deep.equal({ dtoverlay: ['vc4-fkms-v3d'] });
			expect(
				(DeviceConfig as any).ensureRequiredOverlay('raspberrypi4-64', {
					test: '123',
					test2: ['123'],
					test3: ['123', '234'],
				}),
			).to.deep.equal({
				test: '123',
				test2: ['123'],
				test3: ['123', '234'],
				dtoverlay: ['vc4-fkms-v3d'],
			});
			expect(
				(DeviceConfig as any).ensureRequiredOverlay('raspberrypi4-64', {
					dtoverlay: 'test',
				}),
			).to.deep.equal({ dtoverlay: ['test', 'vc4-fkms-v3d'] });
			expect(
				(DeviceConfig as any).ensureRequiredOverlay('raspberrypi4-64', {
					dtoverlay: ['test'],
				}),
			).to.deep.equal({ dtoverlay: ['test', 'vc4-fkms-v3d'] });
		});

		it('should not cause a config change when the cloud does not specify the pi4 overlay', () => {
			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","vc4-fkms-v3d"' },
					{ HOST_CONFIG_dtoverlay: '"test"' },
					'raspberrypi4-64',
				),
			).to.equal(false);
			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","vc4-fkms-v3d"' },
					{ HOST_CONFIG_dtoverlay: 'test' },
					'raspberrypi4-64',
				),
			).to.equal(false);
			expect(
				// @ts-ignore accessing private value
				deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","test2","vc4-fkms-v3d"' },
					{ HOST_CONFIG_dtoverlay: '"test","test2"' },
					'raspberrypi4-64',
				),
			).to.equal(false);
		});
	});

	describe('ConfigFS', () => {
		const upboardConfig = new DeviceConfig();
		let upboardConfigBackend: DeviceConfigBackend | null;

		before(async () => {
			stub(child_process, 'exec').resolves();
			stub(fs, 'exists').resolves(true);
			stub(fs, 'mkdir').resolves();
			stub(fs, 'readdir').resolves([]);
			stub(fsUtils, 'writeFileAtomic').resolves();

			stub(fs, 'readFile').callsFake((file) => {
				if (file === 'test/data/mnt/boot/configfs.json') {
					return Promise.resolve(
						JSON.stringify({
							ssdt: ['spidev1,1'],
						}),
					);
				}
				return Promise.resolve('');
			});

			stub(config, 'get').callsFake((key) => {
				return Promise.try(() => {
					if (key === 'deviceType') {
						return 'up-board';
					}
					throw new Error('Unknown fake config key');
				});
			});

			// @ts-ignore accessing private value
			upboardConfigBackend = await upboardConfig.getConfigBackend();
			expect(upboardConfigBackend).is.not.null;
			expect((child_process.exec as SinonSpy).callCount).to.equal(
				3,
				'exec not called enough times',
			);
		});

		after(() => {
			(child_process.exec as SinonStub).restore();
			(fs.exists as SinonStub).restore();
			(fs.mkdir as SinonStub).restore();
			(fs.readdir as SinonStub).restore();
			(fs.readFile as SinonStub).restore();
			(fsUtils.writeFileAtomic as SinonStub).restore();
			(config.get as SinonStub).restore();
		});

		it('should correctly load the configfs.json file', () => {
			expect(child_process.exec).to.be.calledWith('modprobe acpi_configfs');
			expect(child_process.exec).to.be.calledWith(
				'cat test/data/boot/acpi-tables/spidev1,1.aml > test/data/sys/kernel/config/acpi/table/spidev1,1/aml',
			);
			expect((fs.exists as SinonSpy).callCount).to.equal(2);
			expect((fs.readFile as SinonSpy).callCount).to.equal(4);
		});

		it('should correctly write the configfs.json file', async () => {
			const current = {};
			const target = {
				HOST_CONFIGFS_ssdt: 'spidev1,1',
			};

			(child_process.exec as SinonSpy).resetHistory();
			(fs.exists as SinonSpy).resetHistory();
			(fs.mkdir as SinonSpy).resetHistory();
			(fs.readdir as SinonSpy).resetHistory();
			(fs.readFile as SinonSpy).resetHistory();

			// @ts-ignore accessing private value
			upboardConfig.bootConfigChangeRequired(
				upboardConfigBackend,
				current,
				target,
			);
			// @ts-ignore accessing private value
			await upboardConfig.setBootConfig(upboardConfigBackend, target);

			expect(child_process.exec).to.be.calledOnce;
			expect(fsUtils.writeFileAtomic).to.be.calledWith(
				'test/data/mnt/boot/configfs.json',
				JSON.stringify({
					ssdt: ['spidev1,1'],
				}),
			);
			expect(logSpy).to.be.calledTwice;
			expect(logSpy.getCall(1).args[2]).to.equal('Apply boot config success');
		});
	});

	// This will require stubbing device.reboot, gosuper.post, config.get/set
	it('applies the target state');
});
