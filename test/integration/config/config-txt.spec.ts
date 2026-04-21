import { testfs } from 'mocha-pod';
import { stripIndent } from 'common-tags';

import { expect } from 'chai';
import * as hostUtils from '~/lib/host-utils';

import { promises as fs } from 'fs';
import { ConfigTxt } from '~/src/config/backends/config-txt';

describe('config/config-txt', () => {
	it('correctly parses a config.txt file', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        initramfs initramf.gz 0x00800000
					dtparam=i2c=on
					dtparam=audio=on
					dtoverlay=ads7846
					enable_uart=1
					avoid_warnings=1
					gpio=8=pd
					gpio=17=op,dh
					gpu_mem=16
					hdmi_force_hotplug:1=1
					dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
					dtparam=gpio_out_pin=17`,
		}).enable();

		const configTxt = new ConfigTxt();

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: [
				'ads7846',
				'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13,gpio_out_pin=17',
			],
			enable_uart: '1',
			avoid_warnings: '1',
			gpio: ['8=pd', '17=op,dh'],
			gpu_mem: '16',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		await tfs.restore();
	});

	it('correctly parses a config.txt file with repeated overlays', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        gpu_mem=64
					avoid_warnings=1
					dtoverlay=vc4-kms-v3d
					dtoverlay=ads1015
					dtparam=addr=0x48
					dtparam=cha_cfg=4
					dtparam=chb_cfg=5
					dtparam=chc_cfg=6
					dtparam=chd_cfg=7
					dtoverlay=ads1015
					dtparam=addr=0x49
					dtparam=chc_enable=false
					dtparam=chd_enable=false
					dtparam=cha_cfg=0
					dtparam=chb_cfg=3
					dtparam=i2c_arm=on
					dtparam=spi=on
					dtparam=audio=on
					enable_uart=0
					gpio=8=pd
					gpio=17=op,dh
					`,
		}).enable();

		const configTxt = new ConfigTxt();

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: ['i2c_arm=on', 'spi=on', 'audio=on'],
			dtoverlay: [
				'vc4-kms-v3d',
				'ads1015,addr=0x48,cha_cfg=4,chb_cfg=5,chc_cfg=6,chd_cfg=7',
				'ads1015,addr=0x49,chc_enable=false,chd_enable=false,cha_cfg=0,chb_cfg=3',
			],
			enable_uart: '0',
			avoid_warnings: '1',
			gpio: ['8=pd', '17=op,dh'],
			gpu_mem: '64',
		});

		await tfs.restore();
	});

	it('correctly parses a config.txt file with an empty overlay', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        initramfs initramf.gz 0x00800000
					dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
					dtparam=gpio_out_pin=17
					enable_uart=1
					avoid_warnings=1
					dtoverlay=
					dtparam=i2c=on
					dtparam=lala=on
					dtparam=audio=on
					dtoverlay=ads7846
					gpu_mem=16
					hdmi_force_hotplug:1=1
					`,
		}).enable();

		const configTxt = new ConfigTxt();

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: ['i2c=on', 'audio=on', 'lala=on'],
			dtoverlay: [
				'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13,gpio_out_pin=17',
				'ads7846',
			],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '16',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		await tfs.restore();
	});

	it('correctly parses default params on config.txt', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        initramfs initramf.gz 0x00800000
					dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
					dtparam=gpio_out_pin=17
					enable_uart=1
					avoid_warnings=1
					dtparam=spi=on
					dtparam=audio=on
					dtparam=i2c=on
					dtparam=i2c_arm=on
					dtparam=i2c_vc=on
					dtparam=i2c_baudrate=100000
					dtparam=i2c_arm_baudrate=100000
					dtoverlay=ads7846
					dtparam=i2c_vc_baudrate=100000
					gpu_mem=16
					hdmi_force_hotplug:1=1
					`,
		}).enable();

		const configTxt = new ConfigTxt();

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: [
				'spi=on',
				'audio=on',
				'i2c=on',
				'i2c_arm=on',
				'i2c_vc=on',
				'i2c_baudrate=100000',
				'i2c_arm_baudrate=100000',
				'i2c_vc_baudrate=100000',
			],
			dtoverlay: [
				'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13,gpio_out_pin=17',
				'ads7846',
			],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '16',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		await tfs.restore();
	});

	it('maintains ordering of dtoverlays and dtparams', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        initramfs initramf.gz 0x00800000
					dtparam=i2c=on
					dtparam=audio=on
					dtoverlay=ads7846
					enable_uart=1
					avoid_warnings=1
					gpu_mem=16
					hdmi_force_hotplug:1=1
					dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13
					dtoverlay=ads1015,addr=0x48,cha_enable=true
					dtparam=chb_enable=true
					dtparam=chc_enable=true
			`,
		}).enable();

		const configTxt = new ConfigTxt();

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: [
				'ads7846',
				'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13',
				'ads1015,addr=0x48,cha_enable=true,chb_enable=true,chc_enable=true',
			],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '16',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		await tfs.restore();
	});

	it('splits dtoverlays into params to stay under the 80 char limit', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        enable_uart=1
					dtparam=i2c_arm=on
					dtparam=spi=on
					disable_splash=1
					dtparam=audio=on
					gpu_mem=16
					`,
		}).enable();

		const configTxt = new ConfigTxt();

		await configTxt.setBootConfig({
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: [
				'ads7846',
				'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13',
				'ads1015,addr=0x48,cha_enable=true,chb_enable=true',
			],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '256',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		// Confirm that the file was written correctly
		await expect(
			fs.readFile(hostUtils.pathOnBoot('config.txt'), 'utf8'),
		).to.eventually.equal(
			stripIndent`
					dtparam=i2c=on
					dtparam=audio=on
					enable_uart=1
					avoid_warnings=1
					gpu_mem=256
					initramfs initramf.gz 0x00800000
					hdmi_force_hotplug:1=1
					dtoverlay=ads7846
					dtoverlay=lirc-rpi
					dtparam=gpio_out_pin=17
					dtparam=gpio_in_pin=13
					dtoverlay=ads1015
					dtparam=addr=0x48
					dtparam=cha_enable=true
					dtparam=chb_enable=true
				` + '\n',
		);
		await tfs.restore();
	});

	it('ensures required fields are written to config.txt', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        enable_uart=1
					dtparam=i2c_arm=on
					dtparam=spi=on
					disable_splash=1
					dtparam=audio=on
					gpu_mem=16
					`,
		}).enable();

		const configTxt = new ConfigTxt();

		await configTxt.setBootConfig({
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: ['ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13'],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '256',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: ['ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13'],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '256',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		await tfs.restore();
	});

	it('ignores empty dtoverlay on the target state', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('config.txt')]: stripIndent`
	        enable_uart=1
					dtparam=i2c_arm=on
					dtparam=spi=on
					disable_splash=1
					dtparam=audio=on
					gpu_mem=16
					`,
		}).enable();

		const configTxt = new ConfigTxt();

		await configTxt.setBootConfig({
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: [''],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '256',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		await expect(
			fs.readFile(hostUtils.pathOnBoot('config.txt'), 'utf8'),
		).to.eventually.equal(
			stripIndent`
					dtparam=i2c=on
					dtparam=audio=on
					enable_uart=1
					avoid_warnings=1
					gpu_mem=256
					initramfs initramf.gz 0x00800000
					hdmi_force_hotplug:1=1
				` + '\n',
		);

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: ['i2c=on', 'audio=on'],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '256',
			initramfs: 'initramf.gz 0x00800000',
			'hdmi_force_hotplug:1': '1',
		});

		await tfs.restore();
	});
});
