import { testfs } from 'mocha-pod';
import { stripIndent } from 'common-tags';

import { expect } from 'chai';
import * as hostUtils from '~/lib/host-utils';

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
					gpu_mem=16
					hdmi_force_hotplug:1=1
					dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13`,
		}).enable();

		const configTxt = new ConfigTxt();

		// Will try to parse /test/data/mnt/boot/config.txt
		await expect(configTxt.getBootConfig()).to.eventually.deep.equal({
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: ['ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13'],
			enable_uart: '1',
			avoid_warnings: '1',
			gpu_mem: '16',
			initramfs: 'initramf.gz 0x00800000',
			// This syntax is supported by the backend but not the cloud side
			'hdmi_force_hotplug:1': '1',
		});

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
});
