import _ from 'lodash';

import type { ConfigOptions } from './backend';
import { ConfigBackend } from './backend';
import * as constants from '../../lib/constants';
import log from '../../lib/supervisor-console';
import { exists } from '../../lib/fs-utils';
import * as hostUtils from '../../lib/host-utils';

const ARRAY_CONFIGS = [
	'dtparam',
	'dtoverlay',
	'device_tree_param',
	'device_tree_overlay',
	'gpio',
] as const;

type ArrayConfig = (typeof ARRAY_CONFIGS)[number];

// Refinement on the ConfigOptions type
// to indicate what properties are arrays
type ConfigTxtOptions = ConfigOptions & {
	[key in ArrayConfig]?: string[];
};

function isArrayConfig(x: string): x is ArrayConfig {
	return x != null && ARRAY_CONFIGS.includes(x as any);
}

// We use the empty string as the identifier of the base
// overlay to allow handling the case where the user defines an
// empty overlay as `dtoverlay=`
const BASE_OVERLAY = '';

function isBaseParam(dtparam: string): boolean {
	const match = /^([^=]+)=(.*)$/.exec(dtparam);
	let key = dtparam;
	if (match != null) {
		key = match[1];
	}

	// These hardcoded params correspond to the params set
	// in the default config.txt provided by balena for pi devices
	// See: https://www.raspberrypi.com/documentation/computers/configuration.html#part3.3
	if (
		[
			'audio',
			'spi',
			'i2c',
			'i2c_arm',
			'i2c_vc',
			'i2c_baudrate',
			'i2c_arm_baudrate',
			'i2c_vc_baudrate',
		].includes(key)
	) {
		return true;
	}
	return false;
}

/**
 * A backend to handle Raspberry Pi host configuration
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_CONFIG_dtparam = value | "value" | "value1","value2"
 * 	- {BALENA|RESIN}_HOST_CONFIG_dtoverlay = value | "value" | "value1","value2"
 * 	- {BALENA|RESIN}_HOST_CONFIG_device_tree_param = value | "value" | "value1","value2"
 * 	- {BALENA|RESIN}_HOST_CONFIG_device_tree_overlay = value | "value" | "value1","value2"
 * 	- {BALENA|RESIN}_HOST_CONFIG_gpio = value | "value" | "value1","value2"
 */
export class ConfigTxt extends ConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}CONFIG_`;
	private static bootConfigPath = hostUtils.pathOnBoot('config.txt');

	public static bootConfigVarRegex = new RegExp(
		'(?:' + _.escapeRegExp(ConfigTxt.bootConfigVarPrefix) + ')(.+)',
	);

	private static forbiddenConfigKeys = [
		'disable_commandline_tags',
		'cmdline',
		'kernel',
		'kernel_address',
		'kernel_old',
		'ramfsfile',
		'ramfsaddr',
		'initramfs',
		'device_tree_address',
		'init_emmc_clock',
		'avoid_safe_mode',
	];

	public async matches(deviceType: string): Promise<boolean> {
		return (
			[
				'fincm3',
				'rt-rpi-300',
				'243390-rpi3',
				'nebra-hnt',
				'revpi-connect',
				'revpi-connect-s',
				'revpi-core-3',
				'revpi-connect-4',
			].includes(deviceType) || deviceType.startsWith('raspberry')
		);
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		let configContents = '';

		if (await exists(ConfigTxt.bootConfigPath)) {
			configContents = await hostUtils.readFromBoot(
				ConfigTxt.bootConfigPath,
				'utf-8',
			);
		} else {
			return {};
		}

		const conf: ConfigTxtOptions = {};
		const configStatements = configContents.split(/\r?\n/);

		const baseParams: string[] = [];
		const overlayQueue: Array<[string, string[]]> = [
			[BASE_OVERLAY, baseParams],
		];

		for (const configStr of configStatements) {
			// Don't show warnings for comments and empty lines
			const trimmed = configStr.trimStart();
			if (trimmed.startsWith('#') || trimmed === '') {
				continue;
			}

			// Try to split the line into key+value
			let keyValue = /^([^=]+)=(.*)$/.exec(configStr);
			if (keyValue != null) {
				const [, key, value] = keyValue;
				if (!isArrayConfig(key)) {
					// If key is not one of the array configs, just add it to the
					// configuration
					conf[key] = value;
				} else {
					// dtparams and dtoverlays need to be treated as a special case
					if (key === 'dtparam') {
						const [, currParams] = overlayQueue[overlayQueue.length - 1];
						// The specification allows multiple params in a line
						const params = value.split(',');
						params.forEach((param) => {
							if (isBaseParam(param)) {
								// We make sure to put the base param in the right overlays
								// since RPI doesn't seem to be too strict about the ordering
								// when it comes to these base params
								baseParams.push(value);
							} else {
								currParams.push(value);
							}
						});
					} else if (key === 'dtoverlay') {
						// Assume that the first element is the overlay name
						// we don't validate that the value is well formed
						const [overlay, ...params] = value.split(',');

						// A new dtoverlay statement means we add a new entry to the
						// queue with the given params list
						overlayQueue.push([overlay, params]);
					} else {
						// Otherwise push the new value to the array
						if (conf[key] == null) {
							conf[key] = [];
						}
						conf[key]!.push(value);
					}
				}
				continue;
			}

			// If the line does not match a key-value pair, we check
			// if it is initramfs, otherwise ignore it
			keyValue = /^(initramfs) (.+)/.exec(configStr);
			if (keyValue != null) {
				const [, key, value] = keyValue;
				conf[key] = value;
			} else {
				log.warn(`Could not parse config.txt entry: ${configStr}. Ignoring.`);
			}
		}

		for (const [overlay, params] of overlayQueue) {
			// Convert the base overlay to global dtparams
			if (overlay === BASE_OVERLAY && params.length > 0) {
				conf.dtparam = conf.dtparam != null ? conf.dtparam : [];
				conf.dtparam.push(...params);
			} else if (overlay !== BASE_OVERLAY) {
				// Convert dtoverlays to array format
				conf.dtoverlay = conf.dtoverlay != null ? conf.dtoverlay : [];
				conf.dtoverlay.push([overlay, ...params].join(','));
			}
		}

		return conf;
	}

	public async setBootConfig(opts: ConfigTxtOptions): Promise<void> {
		const confStatements = Object.entries(opts)
			// Treat dtoverlays separately
			.filter(([key]) => key !== 'dtoverlay')
			.flatMap(([key, value]) => {
				if (key === 'initramfs') {
					return `${key} ${value}`;
				} else if (Array.isArray(value)) {
					return value.map((entry) => `${key}=${entry}`);
				} else {
					return `${key}=${value}`;
				}
			});

		// Split dtoverlays from their params to avoid running into char limits
		// and write at the end to prevent overriding the base overlay
		if (opts.dtoverlay != null) {
			for (let entry of opts.dtoverlay) {
				entry = entry.trim();
				if (entry.length === 0) {
					continue;
				}
				const [overlay, ...params] = entry.split(',');
				confStatements.push(`dtoverlay=${overlay}`);
				confStatements.push(...params.map((p) => `dtparam=${p}`));
			}
		}

		const confStr = `${confStatements.join('\n')}\n`;
		await hostUtils.writeToBoot(ConfigTxt.bootConfigPath, confStr);
	}

	public isSupportedConfig(configName: string): boolean {
		return !ConfigTxt.forbiddenConfigKeys.includes(configName);
	}

	public isBootConfigVar(envVar: string): boolean {
		return envVar.startsWith(ConfigTxt.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string {
		return envVar.replace(ConfigTxt.bootConfigVarRegex, '$1');
	}

	public processConfigVarValue(key: string, value: string): string | string[] {
		if (isArrayConfig(key)) {
			if (!value.startsWith('"')) {
				if (key === 'dtoverlay' && value.trim().length === 0) {
					return [];
				}
				return [value];
			} else {
				const res: string[] = JSON.parse(`[${value}]`);
				if (key === 'dtoverlay') {
					return res.filter((s) => s.trim().length > 0);
				}
				return res;
			}
		}
		return value;
	}

	public createConfigVarName(configName: string): string {
		return ConfigTxt.bootConfigVarPrefix + configName;
	}

	// Ensure that the balena-fin overlay is defined in the target configuration
	// overrides the parent
	public ensureRequiredConfig(deviceType: string, conf: ConfigOptions) {
		if (deviceType === 'fincm3') {
			this.ensureDtoverlay(conf, 'balena-fin');
		}

		return conf;
	}

	// Modifies conf
	private ensureDtoverlay(conf: ConfigOptions, field: string) {
		if (conf.dtoverlay == null) {
			conf.dtoverlay = [];
		} else if (typeof conf.dtoverlay === 'string') {
			conf.dtoverlay = [conf.dtoverlay];
		}
		if (!_.includes(conf.dtoverlay, field)) {
			conf.dtoverlay.push(field);
		}
		conf.dtoverlay = conf.dtoverlay.filter((s) => !_.isEmpty(s));

		return conf;
	}
}
