import * as _ from 'lodash';
import { fs } from 'mz';

import {
	ConfigOptions,
	DeviceConfigBackend,
	bootMountPoint,
	remountAndWriteAtomic,
} from '../backend';
import * as constants from '../../lib/constants';
import log from '../../lib/supervisor-console';

/**
 * A backend to handle ConfigFS host configuration for ACPI SSDT loading
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_CONFIGFS_ssdt = value | "value" | "value1","value2"
 */

export class RPiConfigBackend extends DeviceConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}CONFIG_`;
	private static bootConfigPath = `${bootMountPoint}/config.txt`;

	public static bootConfigVarRegex = new RegExp(
		'(' + _.escapeRegExp(RPiConfigBackend.bootConfigVarPrefix) + ')(.+)',
	);

	private static arrayConfigKeys = [
		'dtparam',
		'dtoverlay',
		'device_tree_param',
		'device_tree_overlay',
		'gpio',
	];
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

	public matches(deviceType: string): boolean {
		return _.startsWith(deviceType, 'raspberry') || deviceType === 'fincm3';
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		let configContents = '';

		if (await fs.exists(RPiConfigBackend.bootConfigPath)) {
			configContents = await fs.readFile(
				RPiConfigBackend.bootConfigPath,
				'utf-8',
			);
		} else {
			await fs.writeFile(RPiConfigBackend.bootConfigPath, '');
		}

		const conf: ConfigOptions = {};
		const configStatements = configContents.split(/\r?\n/);

		for (const configStr of configStatements) {
			// Don't show warnings for comments and empty lines
			const trimmed = _.trimStart(configStr);
			if (_.startsWith(trimmed, '#') || trimmed === '') {
				continue;
			}
			let keyValue = /^([^=]+)=(.*)$/.exec(configStr);
			if (keyValue != null) {
				const [, key, value] = keyValue;
				if (!_.includes(RPiConfigBackend.arrayConfigKeys, key)) {
					conf[key] = value;
				} else {
					if (conf[key] == null) {
						conf[key] = [];
					}
					const confArr = conf[key];
					if (!_.isArray(confArr)) {
						throw new Error(
							`Expected '${key}' to have a config array but got ${typeof confArr}`,
						);
					}
					confArr.push(value);
				}
				continue;
			}

			// Try the next regex instead
			keyValue = /^(initramfs) (.+)/.exec(configStr);
			if (keyValue != null) {
				const [, key, value] = keyValue;
				conf[key] = value;
			} else {
				log.warn(`Could not parse config.txt entry: ${configStr}. Ignoring.`);
			}
		}

		return conf;
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		let confStatements: string[] = [];

		_.each(opts, (value, key) => {
			if (key === 'initramfs') {
				confStatements.push(`${key} ${value}`);
			} else if (_.isArray(value)) {
				confStatements = confStatements.concat(
					_.map(value, (entry) => `${key}=${entry}`),
				);
			} else {
				confStatements.push(`${key}=${value}`);
			}
		});

		const confStr = `${confStatements.join('\n')}\n`;

		await remountAndWriteAtomic(RPiConfigBackend.bootConfigPath, confStr);
	}

	public isSupportedConfig(configName: string): boolean {
		return !_.includes(RPiConfigBackend.forbiddenConfigKeys, configName);
	}

	public isBootConfigVar(envVar: string): boolean {
		return _.startsWith(envVar, RPiConfigBackend.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string {
		return envVar.replace(RPiConfigBackend.bootConfigVarRegex, '$2');
	}

	public processConfigVarValue(key: string, value: string): string | string[] {
		if (_.includes(RPiConfigBackend.arrayConfigKeys, key)) {
			if (!_.startsWith(value, '"')) {
				return [value];
			} else {
				return JSON.parse(`[${value}]`);
			}
		}
		return value;
	}

	public createConfigVarName(configName: string): string {
		return RPiConfigBackend.bootConfigVarPrefix + configName;
	}
}
