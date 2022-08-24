import { stub } from 'sinon';
import * as _ from 'lodash';
import { expect } from 'chai';

import * as config from '~/src/config';
import * as configUtils from '~/src/config/utils';
import { ExtraUEnv } from '~/src/config/backends/extra-uEnv';
import { Extlinux } from '~/src/config/backends/extlinux';
import { ConfigTxt } from '~/src/config/backends/config-txt';
import { ConfigFs } from '~/src/config/backends/config-fs';
import { SplashImage } from '~/src/config/backends/splash-image';
import { ConfigBackend } from '~/src/config/backends/backend';

describe('Config Utilities', () => {
	it('gets list of supported backends', async () => {
		// Stub so that we get an array containing only config-txt backend
		const configStub = stub(config, 'get').resolves('raspberry');
		// Get list of backends
		const devices = await configUtils.getSupportedBackends();
		expect(devices.length).to.equal(2);
		expect(devices[0].constructor.name).to.equal('ConfigTxt');
		expect(devices[1].constructor.name).to.equal('SplashImage');
		// Restore stub
		configStub.restore();
		// TO-DO: When we have a device that will match for multiple backends
		// add a test that we get more then 1 backend for that device
	});

	it('transforms environment variables to boot configs', () => {
		_.forEach(CONFIGS, (configObj: any, key: string) => {
			expect(
				configUtils.envToBootConfig(BACKENDS[key], configObj.envVars),
			).to.deep.equal(configObj.bootConfig);
		});
	});

	it('transforms boot configs to environment variables', () => {
		_.forEach(CONFIGS, (configObj: any, key: string) => {
			expect(
				configUtils.bootConfigToEnv(BACKENDS[key], configObj.bootConfig),
			).to.deep.equal(configObj.envVars);
		});
	});
});

const BACKENDS: Record<string, ConfigBackend> = {
	extraUEnv: new ExtraUEnv(),
	extlinux: new Extlinux(),
	configtxt: new ConfigTxt(),
	configfs: new ConfigFs(),
	splashImage: new SplashImage(),
};

const CONFIGS = {
	extraUEnv: {
		envVars: {
			HOST_EXTLINUX_fdt: '/boot/mycustomdtb.dtb',
			HOST_EXTLINUX_isolcpus: '1,2,3',
			HOST_EXTLINUX_rootwait: '',
		},
		bootConfig: {
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '1,2,3',
			rootwait: '',
		},
	},
	extlinux: {
		envVars: {
			HOST_EXTLINUX_fdt: '/boot/mycustomdtb.dtb',
			HOST_EXTLINUX_isolcpus: '1,2,3',
			HOST_EXTLINUX_rootwait: '',
		},
		bootConfig: {
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '1,2,3',
			rootwait: '',
		},
	},
	configtxt: {
		envVars: {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
			HOST_CONFIG_dtoverlay:
				'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
			HOST_CONFIG_foobar: 'baz',
		},
		bootConfig: {
			initramfs: 'initramf.gz 0x00800000',
			dtparam: ['i2c=on', 'audio=on'],
			dtoverlay: ['ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13'],
			foobar: 'baz',
		},
	},
	splashImage: {
		envVars: {
			HOST_SPLASH_image: 'data:image/png;base64,aaa',
		},
		bootConfig: {
			image: 'data:image/png;base64,aaa',
		},
	},
	// TO-DO: Config-FS is commented out because it behaves differently and doesn't
	// add value to the Config Utilities if we make it work but would like to add it
	// configfs: {
	// 	envVars: {
	// 		ssdt: 'spidev1,1'
	// 	},
	// 	bootConfig: {
	// 		ssdt: ['spidev1,1']
	// 	},
	// },
};
