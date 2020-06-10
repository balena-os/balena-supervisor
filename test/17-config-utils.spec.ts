import { expect } from './lib/chai-config';
import * as configUtils from '../src/config/utils';
import { RPiConfigBackend } from '../src/config/backend';

const rpiBackend = new RPiConfigBackend();

describe('Config Utilities', () => {
	describe('Boot config', () => {
		it('correctly transforms environments to boot config objects', () => {
			const bootConfig = configUtils.envToBootConfig(rpiBackend, {
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
				HOST_CONFIG_dtoverlay:
					'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
				HOST_CONFIG_foobar: 'baz',
			});
			expect(bootConfig).to.deep.equal({
				initramfs: 'initramf.gz 0x00800000',
				dtparam: ['i2c=on', 'audio=on'],
				dtoverlay: ['ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13'],
				foobar: 'baz',
			});
		});
	});
});
