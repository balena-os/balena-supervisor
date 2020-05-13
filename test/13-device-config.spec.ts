import { Promise } from 'bluebird';
import { stripIndent } from 'common-tags';
import { child_process, fs } from 'mz';
import { SinonSpy, SinonStub, spy, stub } from 'sinon';

import { ExtlinuxConfigBackend, RPiConfigBackend } from '../src/config/backend';
import { DeviceConfig } from '../src/device-config';
import * as fsUtils from '../src/lib/fs-utils';
import { expect } from './lib/chai-config';

import prepare = require('./lib/prepare');

const extlinuxBackend = new ExtlinuxConfigBackend();
const rpiConfigBackend = new RPiConfigBackend();

describe('DeviceConfig', function () {
	before(function () {
		prepare();
		this.fakeDB = {};
		this.fakeConfig = {
			get(key: string) {
				return Promise.try(function () {
					if (key === 'deviceType') {
						return 'raspberrypi3';
					} else {
						throw new Error('Unknown fake config key');
					}
				});
			},
		};
		this.fakeLogger = {
			logSystemMessage: spy(),
		};
		return (this.deviceConfig = new DeviceConfig({
			logger: this.fakeLogger,
			db: this.fakeDB,
			config: this.fakeConfig,
		}));
	});

	// Test that the format for special values like initramfs and array variables is parsed correctly
	it('allows getting boot config with getBootConfig', function () {
		stub(fs, 'readFile').resolves(stripIndent`
			initramfs initramf.gz 0x00800000\n\
			dtparam=i2c=on\n\
			dtparam=audio=on\n\
			dtoverlay=ads7846\n\
			dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13\n\
			foobar=baz\n\
		`);
		return this.deviceConfig
			.getBootConfig(rpiConfigBackend)
			.then(function (conf: any) {
				(fs.readFile as SinonStub).restore();
				return expect(conf).to.deep.equal({
					HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
					HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
					HOST_CONFIG_dtoverlay:
						'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
					HOST_CONFIG_foobar: 'baz',
				});
			});
	});

	it('properly reads a real config.txt file', function () {
		return this.deviceConfig.getBootConfig(rpiConfigBackend).then((conf: any) =>
			expect(conf).to.deep.equal({
				HOST_CONFIG_dtparam: '"i2c_arm=on","spi=on","audio=on"',
				HOST_CONFIG_enable_uart: '1',
				HOST_CONFIG_disable_splash: '1',
				HOST_CONFIG_avoid_warnings: '1',
				HOST_CONFIG_gpu_mem: '16',
			}),
		);
	});

	// Test that the format for special values like initramfs and array variables is preserved
	it('does not allow setting forbidden keys', function () {
		const current = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
			HOST_CONFIG_dtoverlay:
				'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
			HOST_CONFIG_foobar: 'baz',
		};
		const target = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00810000',
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
			HOST_CONFIG_dtoverlay:
				'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
			HOST_CONFIG_foobar: 'baz',
		};
		const promise = Promise.try(() => {
			return this.deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				current,
				target,
			);
		});
		expect(promise).to.be.rejected;
		return promise.catch((_err) => {
			expect(this.fakeLogger.logSystemMessage).to.be.calledOnce;
			expect(this.fakeLogger.logSystemMessage).to.be.calledWith(
				'Attempt to change blacklisted config value initramfs',
				{
					error: 'Attempt to change blacklisted config value initramfs',
				},
				'Apply boot config error',
			);
			return this.fakeLogger.logSystemMessage.resetHistory();
		});
	});

	it('does not try to change config.txt if it should not change', function () {
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
		const promise = Promise.try(() => {
			return this.deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				current,
				target,
			);
		});
		expect(promise).to.eventually.equal(false);
		return promise.then(() => {
			expect(this.fakeLogger.logSystemMessage).to.not.be.called;
			return this.fakeLogger.logSystemMessage.resetHistory();
		});
	});

	it('writes the target config.txt', function () {
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
		const promise = Promise.try(() => {
			return this.deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				current,
				target,
			);
		});
		expect(promise).to.eventually.equal(true);
		return promise.then(() => {
			return this.deviceConfig
				.setBootConfig(rpiConfigBackend, target)
				.then(() => {
					expect(child_process.exec).to.be.calledOnce;
					expect(this.fakeLogger.logSystemMessage).to.be.calledTwice;
					expect(this.fakeLogger.logSystemMessage.getCall(1).args[2]).to.equal(
						'Apply boot config success',
					);
					expect(fsUtils.writeFileAtomic).to.be.calledWith(
						'./test/data/mnt/boot/config.txt',
						`\
initramfs initramf.gz 0x00800000\n\
dtparam=i2c=on\n\
dtparam=audio=off\n\
dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13\n\
foobar=bat\n\
foobaz=bar\n\
`,
					);
					(fsUtils.writeFileAtomic as SinonStub).restore();
					(child_process.exec as SinonStub).restore();
					return this.fakeLogger.logSystemMessage.resetHistory();
				});
		});
	});

	it('accepts RESIN_ and BALENA_ variables', function () {
		return this.deviceConfig
			.formatConfigKeys({
				FOO: 'bar',
				BAR: 'baz',
				RESIN_HOST_CONFIG_foo: 'foobaz',
				BALENA_HOST_CONFIG_foo: 'foobar',
				RESIN_HOST_CONFIG_other: 'val',
				BALENA_HOST_CONFIG_baz: 'bad',
				BALENA_SUPERVISOR_POLL_INTERVAL: '100',
			})
			.then((filteredConf: any) =>
				expect(filteredConf).to.deep.equal({
					HOST_CONFIG_foo: 'foobar',
					HOST_CONFIG_other: 'val',
					HOST_CONFIG_baz: 'bad',
					SUPERVISOR_POLL_INTERVAL: '100',
				}),
			);
	});

	it('returns default configuration values', function () {
		const conf = this.deviceConfig.getDefaults();
		return expect(conf).to.deep.equal({
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

	describe('Extlinux files', () =>
		it('should correctly write to extlinux.conf files', function () {
			stub(fsUtils, 'writeFileAtomic').resolves();
			stub(child_process, 'exec').resolves();

			const current = {};
			const target = {
				HOST_EXTLINUX_isolcpus: '2',
			};

			const promise = Promise.try(() => {
				return this.deviceConfig.bootConfigChangeRequired(
					extlinuxBackend,
					current,
					target,
				);
			});
			expect(promise).to.eventually.equal(true);
			return promise.then(() => {
				return this.deviceConfig
					.setBootConfig(extlinuxBackend, target)
					.then(() => {
						expect(child_process.exec).to.be.calledOnce;
						expect(this.fakeLogger.logSystemMessage).to.be.calledTwice;
						expect(
							this.fakeLogger.logSystemMessage.getCall(1).args[2],
						).to.equal('Apply boot config success');
						expect(fsUtils.writeFileAtomic).to.be.calledWith(
							'./test/data/mnt/boot/extlinux/extlinux.conf',
							`\
DEFAULT primary\n\
TIMEOUT 30\n\
MENU TITLE Boot Options\n\
LABEL primary\n\
MENU LABEL primary Image\n\
LINUX /Image\n\
APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=2\n\
`,
						);
						(fsUtils.writeFileAtomic as SinonStub).restore();
						(child_process.exec as SinonStub).restore();
						return this.fakeLogger.logSystemMessage.resetHistory();
					});
			});
		}));

	describe('Balena fin', function () {
		it('should always add the balena-fin dtoverlay', function () {
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
			return expect(
				(DeviceConfig as any).ensureRequiredOverlay('fincm3', {
					dtoverlay: ['test'],
				}),
			).to.deep.equal({ dtoverlay: ['test', 'balena-fin'] });
		});

		return it('should not cause a config change when the cloud does not specify the balena-fin overlay', function () {
			expect(
				this.deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: '"test"' },
					'fincm3',
				),
			).to.equal(false);

			expect(
				this.deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: 'test' },
					'fincm3',
				),
			).to.equal(false);

			return expect(
				this.deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","test2","balena-fin"' },
					{ HOST_CONFIG_dtoverlay: '"test","test2"' },
					'fincm3',
				),
			).to.equal(false);
		});
	});

	describe('Raspberry pi4', function () {
		it('should always add the vc4-fkms-v3d dtoverlay', function () {
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
			return expect(
				(DeviceConfig as any).ensureRequiredOverlay('raspberrypi4-64', {
					dtoverlay: ['test'],
				}),
			).to.deep.equal({ dtoverlay: ['test', 'vc4-fkms-v3d'] });
		});

		return it('should not cause a config change when the cloud does not specify the pi4 overlay', function () {
			expect(
				this.deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","vc4-fkms-v3d"' },
					{ HOST_CONFIG_dtoverlay: '"test"' },
					'raspberrypi4-64',
				),
			).to.equal(false);

			expect(
				this.deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","vc4-fkms-v3d"' },
					{ HOST_CONFIG_dtoverlay: 'test' },
					'raspberrypi4-64',
				),
			).to.equal(false);

			return expect(
				this.deviceConfig.bootConfigChangeRequired(
					rpiConfigBackend,
					{ HOST_CONFIG_dtoverlay: '"test","test2","vc4-fkms-v3d"' },
					{ HOST_CONFIG_dtoverlay: '"test","test2"' },
					'raspberrypi4-64',
				),
			).to.equal(false);
		});
	});

	describe('ConfigFS', function () {
		before(function () {
			const fakeConfig = {
				get(key: string) {
					return Promise.try(function () {
						if (key === 'deviceType') {
							return 'up-board';
						}
						throw new Error('Unknown fake config key');
					});
				},
			};
			this.upboardConfig = new DeviceConfig({
				logger: this.fakeLogger,
				db: this.fakeDB,
				config: fakeConfig as any,
			});

			stub(child_process, 'exec').resolves();
			stub(fs, 'exists').callsFake(() => Promise.resolve(true));
			stub(fs, 'mkdir').resolves();
			stub(fs, 'readdir').callsFake(() => Promise.resolve([]));
			stub(fs, 'readFile').callsFake(function (file) {
				if (file === 'test/data/mnt/boot/configfs.json') {
					return Promise.resolve(
						JSON.stringify({
							ssdt: ['spidev1,1'],
						}),
					);
				}
				return Promise.resolve('');
			});
			stub(fsUtils, 'writeFileAtomic').resolves();

			return Promise.try(() => {
				return this.upboardConfig.getConfigBackend();
			}).then((backend) => {
				this.upboardConfigBackend = backend;
				expect(this.upboardConfigBackend).is.not.null;
				return expect((child_process.exec as SinonSpy).callCount).to.equal(
					3,
					'exec not called enough times',
				);
			});
		});

		it('should correctly load the configfs.json file', function () {
			expect(child_process.exec).to.be.calledWith('modprobe acpi_configfs');
			expect(child_process.exec).to.be.calledWith(
				'cat test/data/boot/acpi-tables/spidev1,1.aml > test/data/sys/kernel/config/acpi/table/spidev1,1/aml',
			);

			expect((fs.exists as SinonSpy).callCount).to.equal(2);
			return expect((fs.readFile as SinonSpy).callCount).to.equal(4);
		});

		it('should correctly write the configfs.json file', function () {
			const current = {};
			const target = {
				HOST_CONFIGFS_ssdt: 'spidev1,1',
			};

			this.fakeLogger.logSystemMessage.resetHistory();
			(child_process.exec as SinonSpy).resetHistory();
			(fs.exists as SinonSpy).resetHistory();
			(fs.mkdir as SinonSpy).resetHistory();
			(fs.readdir as SinonSpy).resetHistory();
			(fs.readFile as SinonSpy).resetHistory();

			return Promise.try(() => {
				expect(this.upboardConfigBackend).is.not.null;
				return this.upboardConfig.bootConfigChangeRequired(
					this.upboardConfigBackend,
					current,
					target,
				);
			})
				.then(() => {
					return this.upboardConfig.setBootConfig(
						this.upboardConfigBackend,
						target,
					);
				})
				.then(() => {
					expect(child_process.exec).to.be.calledOnce;
					expect(fsUtils.writeFileAtomic).to.be.calledWith(
						'test/data/mnt/boot/configfs.json',
						JSON.stringify({
							ssdt: ['spidev1,1'],
						}),
					);
					expect(this.fakeLogger.logSystemMessage).to.be.calledTwice;
					return expect(
						this.fakeLogger.logSystemMessage.getCall(1).args[2],
					).to.equal('Apply boot config success');
				});
		});

		return after(function () {
			(child_process.exec as SinonStub).restore();
			(fs.exists as SinonStub).restore();
			(fs.mkdir as SinonStub).restore();
			(fs.readdir as SinonStub).restore();
			(fs.readFile as SinonStub).restore();
			(fsUtils.writeFileAtomic as SinonStub).restore();
			return this.fakeLogger.logSystemMessage.resetHistory();
		});
	});

	// This will require stubbing device.reboot, gosuper.post, config.get/set
	return it('applies the target state');
});
