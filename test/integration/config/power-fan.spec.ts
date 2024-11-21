import { expect } from 'chai';
import { stripIndent } from 'common-tags';
import { testfs } from 'mocha-pod';
import type { SinonStub } from 'sinon';

import { PowerFanConfig } from '~/src/config/backends/power-fan';
import { Extlinux } from '~/src/config/backends/extlinux';
import { ExtraUEnv } from '~/src/config/backends/extra-uEnv';
import { ConfigTxt } from '~/src/config/backends/config-txt';
import { ConfigFs } from '~/src/config/backends/config-fs';
import { Odmdata } from '~/src/config/backends/odmdata';
import { SplashImage } from '~/src/config/backends/splash-image';
import ConfigJsonConfigBackend from '~/src/config/configJson';
import { schema } from '~/src/config/schema';
import * as hostUtils from '~/lib/host-utils';
import log from '~/lib/supervisor-console';

const SUPPORTED_DEVICE_TYPES = [
	'jetson-agx-orin-devkit',
	'jetson-agx-orin-devkit-64gb',
	'jetson-orin-nano-devkit-nvme',
	'jetson-orin-nano-seeed-j3010',
	'jetson-orin-nx-seeed-j4012',
	'jetson-orin-nx-xavier-nx-devkit',
];

const UNSUPPORTED_DEVICE_TYPES = ['jetson-orin-nx-xv3'];

describe('config/power-fan', () => {
	const CONFIG_PATH = hostUtils.pathOnBoot('config.json');
	const generateConfigJsonBackend = () => new ConfigJsonConfigBackend(schema);
	let powerFanConf: PowerFanConfig;

	beforeEach(async () => {
		await testfs({
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();
	});

	afterEach(async () => {
		await testfs.restore();
	});

	it('only matches supported devices', async () => {
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());
		for (const deviceType of SUPPORTED_DEVICE_TYPES) {
			expect(await powerFanConf.matches(deviceType)).to.be.true;
		}

		for (const deviceType of UNSUPPORTED_DEVICE_TYPES) {
			expect(await powerFanConf.matches(deviceType)).to.be.false;
		}
	});

	it('correctly gets boot configs from config.json', async () => {
		const getConfigJson = (powerMode: string, fanProfile: string) => {
			return stripIndent`
			{
				"os": {
					"extra": "field",
					"power": {
						"mode": "${powerMode}"
					},
					"fan": {
						"profile": "${fanProfile}"
					}
				}
			}`;
		};

		for (const powerMode of ['low', 'mid', 'high', 'custom_power']) {
			for (const fanProfile of ['quiet', 'default', 'cool', 'custom_fan']) {
				await testfs({
					[CONFIG_PATH]: getConfigJson(powerMode, fanProfile),
				}).enable();

				// ConfigJsonConfigBackend uses a cache, so setting a Supervisor-managed value
				// directly in config.json (thus circumventing ConfigJsonConfigBackend)
				// will not be reflected in the ConfigJsonConfigBackend instance.
				// We need to create a new instance which will recreate the cache
				// in order to get the latest value.
				powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

				expect(await powerFanConf.getBootConfig()).to.deep.equal({
					power_mode: powerMode,
					fan_profile: fanProfile,
				});

				await testfs.restore();
			}
		}
	});

	it('correctly gets boot configs if power mode is not set', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
            {   
                "os": {
					"extra": "field",
                    "fan": {
                        "profile": "quiet"
                    }
                }
            }`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		const config = await powerFanConf.getBootConfig();
		expect(config).to.deep.equal({
			fan_profile: 'quiet',
		});
	});

	it('correctly gets boot configs if fan profile is not set', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
            {   
                "os": {
					"extra": "field",
                    "power": {
                        "mode": "low"
                    }
                }
            }`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		const config = await powerFanConf.getBootConfig();
		expect(config).to.deep.equal({
			power_mode: 'low',
		});
	});

	it('correctly gets boot configs if no relevant boot configs are set', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
            {   
                "os": {
					"extra": "field"
				}
            }`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		const config = await powerFanConf.getBootConfig();
		expect(config).to.deep.equal({});
	});

	it('ignores unrelated fields in config.json when getting boot configs', async () => {
		const configStr = stripIndent`
		{   
			"apiEndpoint": "https://api.balena-cloud.com",
			"uuid": "deadbeef",
			"os": {
				"power": {
					"mode": "low",
					"extra": "field"
				},
				"extra2": "field2",
				"fan": {
					"profile": "quiet",
					"extra3": "field3"
				},
				"network": {
					"connectivity": {
						"uri": "https://api.balena-cloud.com/connectivity-check",
						"interval": "300",
						"response": "optional value in the response"
					},
					"wifi": {
						"randomMacAddressScan": false
					}
				}
			}
		}`;
		await testfs({
			[CONFIG_PATH]: configStr,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		const config = await powerFanConf.getBootConfig();
		expect(config).to.deep.equal({
			power_mode: 'low',
			fan_profile: 'quiet',
		});

		// Check that unrelated fields are unchanged
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.equal(configStr);
	});

	it('gets boot configs in config.json while current config is empty', async () => {
		await testfs({
			[CONFIG_PATH]: '{}',
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		expect(await powerFanConf.getBootConfig()).to.deep.equal({});
	});

	it('sets boot configs in config.json', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
			{
				"os": {
					"extra": "field"
				}
			}`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		expect(await powerFanConf.getBootConfig()).to.deep.equal({});

		await powerFanConf.setBootConfig({
			power_mode: 'low',
			fan_profile: 'quiet',
		});

		expect(await powerFanConf.getBootConfig()).to.deep.equal({
			power_mode: 'low',
			fan_profile: 'quiet',
		});

		// Sanity check that config.json is updated
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.deep.equal(
			JSON.stringify({
				os: {
					extra: 'field',
					power: {
						mode: 'low',
					},
					fan: {
						profile: 'quiet',
					},
				},
			}),
		);
	});

	it('sets boot configs in config.json while removing any unspecified boot configs', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
			{
				"os": {
					"extra": "field",
					"power": {
						"mode": "low"
					}
				}
			}`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		await powerFanConf.setBootConfig({
			fan_profile: 'cool',
		});

		const config = await powerFanConf.getBootConfig();
		expect(config).to.deep.equal({
			fan_profile: 'cool',
		});

		// Sanity check that power mode is removed
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.deep.equal(
			JSON.stringify({
				os: {
					extra: 'field',
					fan: {
						profile: 'cool',
					},
				},
			}),
		);
	});

	it('sets boot configs in config.json while current config is empty', async () => {
		await testfs({
			[CONFIG_PATH]: '{}',
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		await powerFanConf.setBootConfig({
			power_mode: 'low',
			fan_profile: 'quiet',
		});

		expect(await powerFanConf.getBootConfig()).to.deep.equal({
			power_mode: 'low',
			fan_profile: 'quiet',
		});

		// Sanity check that config.json is updated
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.deep.equal(
			JSON.stringify({
				os: {
					power: {
						mode: 'low',
					},
					fan: {
						profile: 'quiet',
					},
				},
			}),
		);
	});

	it('sets boot configs in config.json while current and target config are empty', async () => {
		await testfs({
			[CONFIG_PATH]: '{}',
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		await powerFanConf.setBootConfig({});

		expect(await powerFanConf.getBootConfig()).to.deep.equal({});

		// Sanity check that config.json is empty
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.deep.equal(JSON.stringify({ os: {} }));
	});

	it('handles setting configs correctly when target configs are empty string', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
			{
				"os": {
					"extra": "field",
					"power": {
						"mode": "low"
					}
				}
			}`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		await powerFanConf.setBootConfig({
			fan_profile: '',
		});

		const config = await powerFanConf.getBootConfig();
		expect(config).to.deep.equal({
			fan_profile: '',
		});

		// Sanity check that config.json is updated
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.deep.equal(
			JSON.stringify({
				os: {
					extra: 'field',
					fan: {
						profile: '',
					},
				},
			}),
		);
	});

	it('does not touch fields besides os.power and os.fan in config.json when setting boot configs', async () => {
		await testfs({
			// Note that extra fields in os.power and os.fan are removed when setting, as os.power
			// and os.fan are considered managed by the Supervisor.
			[CONFIG_PATH]: stripIndent`
			{   
				"apiEndpoint": "https://api.balena-cloud.com",
				"uuid": "deadbeef",
				"os": {
					"power": {
						"mode": "low",
						"extra": "field"
					},
					"extra2": "field2",
					"fan": {
						"profile": "quiet",
						"extra3": "field3"
					},
					"network": {
						"connectivity": {
							"uri": "https://api.balena-cloud.com/connectivity-check",
							"interval": "300",
							"response": "optional value in the response"
						},
						"wifi": {
							"randomMacAddressScan": false
						}
					}
				}
			}`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		await powerFanConf.setBootConfig({
			power_mode: 'high',
			fan_profile: 'cool',
		});

		expect(await powerFanConf.getBootConfig()).to.deep.equal({
			power_mode: 'high',
			fan_profile: 'cool',
		});

		// Sanity check that os.power and os.fan are updated
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.deep.equal(
			JSON.stringify({
				apiEndpoint: 'https://api.balena-cloud.com',
				uuid: 'deadbeef',
				os: {
					power: {
						// Extra fields in os.power are removed when setting
						mode: 'high',
					},
					extra2: 'field2',
					fan: {
						// Extra fields in os.fan are removed when setting
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
				},
			}),
		);
	});

	it('does not touch fields besides os.power and os.fan in config.json when removing boot configs', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
			{   
				"apiEndpoint": "https://api.balena-cloud.com",
				"uuid": "deadbeef",
				"os": {
					"power": {
						"mode": "low",
						"extra": "field"
					},
					"extra2": "field2",
					"fan": {
						"profile": "quiet",
						"extra3": "field3"
					},
					"network": {
						"connectivity": {
							"uri": "https://api.balena-cloud.com/connectivity-check",
							"interval": "300",
							"response": "optional value in the response"
						},
						"wifi": {
							"randomMacAddressScan": false
						}
					}
				}
			}`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		await powerFanConf.setBootConfig({});

		expect(await powerFanConf.getBootConfig()).to.deep.equal({});

		// Sanity check that os.power and os.fan are removed
		const configJson = await hostUtils.readFromBoot(CONFIG_PATH, 'utf-8');
		expect(configJson).to.deep.equal(
			JSON.stringify({
				apiEndpoint: 'https://api.balena-cloud.com',
				uuid: 'deadbeef',
				os: {
					extra2: 'field2',
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
				},
			}),
		);
	});

	it('returns empty object with warning if config.json cannot be parsed', async () => {
		await testfs({
			[CONFIG_PATH]: 'not json',
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		(log.error as SinonStub).resetHistory();

		const config = await powerFanConf.getBootConfig();
		expect(config).to.deep.equal({});
		expect(log.error as SinonStub).to.have.been.calledWithMatch(
			'Failed to read config.json while getting power / fan configs:',
		);
	});

	it('returns empty object if boot config does not have the right schema', async () => {
		await testfs({
			[CONFIG_PATH]: stripIndent`
            {
                "os": {
                    "power": "not an object",
                    "fan": "also not an object",
					"extra": "field"
                }
            }`,
		}).enable();
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());
		expect(await powerFanConf.getBootConfig()).to.deep.equal({});
	});

	it('is the only config backend that supports power mode and fan profile', () => {
		const otherBackends = [
			new Extlinux(),
			new ExtraUEnv(),
			new ConfigTxt(),
			new ConfigFs(),
			new Odmdata(),
			new SplashImage(),
		];
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());

		for (const config of ['power_mode', 'fan_profile']) {
			for (const backend of otherBackends) {
				expect(backend.isBootConfigVar(`HOST_CONFIG_${config}`)).to.be.false;
				expect(backend.isSupportedConfig(`HOST_CONFIG_${config}`)).to.be.false;
			}

			expect(powerFanConf.isBootConfigVar(`HOST_CONFIG_${config}`)).to.be.true;
			expect(powerFanConf.isSupportedConfig(`HOST_CONFIG_${config}`)).to.be
				.true;
		}
	});

	it('converts supported config vars to boot configs regardless of case', () => {
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());
		for (const config of ['power_mode', 'fan_profile']) {
			expect(
				powerFanConf.processConfigVarName(`HOST_CONFIG_${config}`),
			).to.equal(config);
			expect(
				powerFanConf.processConfigVarName(
					`HOST_CONFIG_${config.toUpperCase()}`,
				),
			).to.equal(config);
		}
	});

	it('allows any value for power mode and fan profile', () => {
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());
		for (const config of ['power_mode', 'fan_profile']) {
			expect(powerFanConf.processConfigVarValue(config, 'any value')).to.equal(
				'any value',
			);
		}
	});

	it('creates supported config vars from boot configs', () => {
		powerFanConf = new PowerFanConfig(generateConfigJsonBackend());
		for (const config of ['power_mode', 'fan_profile']) {
			expect(powerFanConf.createConfigVarName(config)).to.equal(
				`HOST_CONFIG_${config}`,
			);
		}
	});
});
