import _ from 'lodash';

import type { ConfigOptions } from './backend';
import { ConfigBackend } from './backend';
import * as constants from '../../lib/constants';
import log from '../../lib/supervisor-console';
import { ExtraUEnvError } from '../../lib/errors';
import * as hostUtils from '../../lib/host-utils';

/**
 * Entry describes the configurable items in an extra_uEnv file
 *
 * @collection - This describes if the value can be a list of items separated by space character.
 *
 */

type Entry = {
	key: EntryKey;
	collection: boolean;
};

// Types of entries supported in a extra_uEnv file
type EntryKey = 'custom_fdt_file' | 'extra_os_cmdline';

// Splits a string from a file into lines
const LINE_REGEX = /(?:\r?\n[\s#]*)+/;

// Splits a line into key value pairs on `=`
const OPTION_REGEX = /^\s*(\w+)=(.*)$/;

/**
 * A backend to handle host configuration with extra_uEnv
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_EXTLINUX_isolcpus = value | "value" | "value1","value2"
 * 	- {BALENA|RESIN}_HOST_EXTLINUX_fdt = value | "value"
 */

export class ExtraUEnv extends ConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}EXTLINUX_`;
	private static bootConfigPath = hostUtils.pathOnBoot('extra_uEnv.txt');

	private static entries: Record<EntryKey, Entry> = {
		custom_fdt_file: {
			key: 'custom_fdt_file',
			collection: false,
		},
		extra_os_cmdline: {
			key: 'extra_os_cmdline',
			collection: true,
		},
	};

	private static supportedConfigs: Dictionary<Entry> = {
		fdt: ExtraUEnv.entries['custom_fdt_file'],
		// @deprecated
		isolcpus: ExtraUEnv.entries['extra_os_cmdline'],
		extra_os_cmdline: ExtraUEnv.entries['extra_os_cmdline'],
	};

	public static bootConfigVarRegex = new RegExp(
		'(?:' + _.escapeRegExp(ExtraUEnv.bootConfigVarPrefix) + ')(.+)',
	);

	// extra_uEnv is supported on all devices
	public async matches(): Promise<boolean> {
		return Promise.resolve(true);
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		// Get config contents at bootConfigPath
		const confContents = await ExtraUEnv.readBootConfigPath();

		// Parse ConfigOptions from bootConfigPath contents
		const parsedConfigFile = ExtraUEnv.parseOptions(confContents);

		// Filter out unsupported values
		return _.pickBy(parsedConfigFile, (_value, key) =>
			this.isSupportedConfig(key),
		);
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// Filter out unsupported options
		const supportedOptions = _.pickBy(opts, (value, key) => {
			if (!this.isSupportedConfig(key)) {
				log.warn(`Not setting unsupported value: { ${key}: ${value} }`);
				return false;
			}
			return true;
		});

		// Write new extra_uEnv configuration
		await hostUtils.writeToBoot(
			ExtraUEnv.bootConfigPath,
			ExtraUEnv.configToString(supportedOptions),
		);
	}

	public isSupportedConfig(config: string): boolean {
		return config in ExtraUEnv.supportedConfigs;
	}

	public isBootConfigVar(envVar: string): boolean {
		return envVar.startsWith(ExtraUEnv.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string | null {
		const name = envVar.replace(ExtraUEnv.bootConfigVarRegex, '$1');
		if (name === envVar) {
			return null;
		}
		return name;
	}

	public processConfigVarValue(_key: string, value: string): string {
		return value;
	}

	public createConfigVarName(configName: string): string | null {
		if (configName === '') {
			return null;
		}
		return `${ExtraUEnv.bootConfigVarPrefix}${configName}`;
	}

	public isEqual(target: ConfigOptions, current: ConfigOptions): boolean {
		// Examples that should return true:
		// 1. Exact same configs
		// - target: { extra_os_cmdline: 'isolcpus=3,4 console=tty0 rootwait' }
		// - current: { extra_os_cmdline: 'isolcpus=3,4 console=tty0 rootwait' }
		// 2. Exact same configs but in a different order
		// - target: { extra_os_cmdline: 'isolcpus=3,4 console=tty0 rootwait' }
		// - current: { extra_os_cmdline: 'console=tty0 isolcpus=3,4 rootwait' }
		// 3. Configs equivalent when combined between extra_os_cmdline & isolcpus
		// - target: { isolcpus: '3,4', extra_os_cmdline: 'console=tty0 rootwait' }
		// - current: { extra_os_cmdline: 'console=tty0 isolcpus=3,4 rootwait' }

		// Convert to config map which normalizes legacy isolcpus into
		// extra_os_cmdline collection and sorts collection values alphabetically.
		const targetMap = ExtraUEnv.configToMap(target);
		const currentMap = ExtraUEnv.configToMap(current);
		if (targetMap.size !== currentMap.size) {
			return false;
		}
		for (const [key, value] of targetMap) {
			if (currentMap.get(key) !== value) {
				return false;
			}
		}
		return true;
	}

	private static parseOptions(configFile: string): ConfigOptions {
		// Exit early if configFile is empty
		if (configFile.length === 0) {
			return {};
		}
		// Split by line and filter any empty lines
		const lines = configFile
			.split(LINE_REGEX)
			.filter((line) => line.trim() !== '');
		// Reduce lines to ConfigOptions
		const configOptions = lines.reduce(
			(options: ConfigOptions, line: string) => {
				// Filter out lines that don't start with an EntryKey
				const isSupported = Object.values(ExtraUEnv.supportedConfigs).some(
					({ key }) => line.startsWith(key),
				);

				const optionValues = line.match(OPTION_REGEX);
				if (optionValues == null || !isSupported) {
					log.warn(`Unsupported or malformed extra_uEnv entry: ${line}`);
					return options;
				}
				// Merge new option with existing options
				return {
					...ExtraUEnv.parseOption(optionValues),
					...options,
				};
			},
			{},
		);
		return configOptions;
	}

	private static parseOption(optionArray: string[]): ConfigOptions {
		const [, KEY, VALUE] = optionArray;
		// Check if this key's value is a collection
		if (ExtraUEnv.supportedConfigs[KEY as EntryKey]?.collection) {
			// Return normalized collection of options
			return { [KEY]: ExtraUEnv.normalizeOptionValue(VALUE) };
		}
		// Find the option that belongs to this entry
		const optionKey = _.findKey(
			ExtraUEnv.supportedConfigs,
			(config) => config.key === KEY,
		);
		// Check if we found a corresponding option for this entry
		if (typeof optionKey !== 'string') {
			log.warn(`Could not parse unsupported option: ${optionArray[0]}`);
			return {};
		}
		return { [optionKey]: VALUE };
	}

	private static normalizeOptionValue(
		collectionValue: string | string[],
	): string {
		return (
			(
				typeof collectionValue === 'string'
					? collectionValue
					: collectionValue.join(' ')
			)
				// Split collection into individual options
				.split(' ')
				// Filter out empty options
				.filter((option) => option)
				// Sort collection option by key
				.sort((a, b) => a.split('=')[0].localeCompare(b.split('=')[0]))
				// Join sorted options back into a string
				.join(' ')
		);
	}

	private static async readBootConfigPath(): Promise<string> {
		try {
			return await hostUtils.readFromBoot(ExtraUEnv.bootConfigPath, 'utf-8');
		} catch (e) {
			if ((e as hostUtils.CodedError).code === 'ENOENT') {
				// File doesn't exist, so we need to create it
				await hostUtils.writeToBoot(ExtraUEnv.bootConfigPath, '');
				return '';
			}
			// For other cases where file exists but is corrupted in some way, warn the user
			log.error(
				`Unable to find extra_uEnv file at: ${ExtraUEnv.bootConfigPath}`,
			);
			throw new ExtraUEnvError(
				'Could not read extra_uEnv file. Device is possibly bricked',
			);
		}
	}

	private static configToString(configs: ConfigOptions): string {
		// Get Map of ConfigOptions object
		const configMap = ExtraUEnv.configToMap(configs);
		// Iterator over configMap and concat to configString
		let configString = '';
		for (const [key, value] of configMap) {
			// Append new config
			configString += `${key}=${value}\n`;
		}
		return configString;
	}

	private static configToMap(configs: ConfigOptions): Map<string, string> {
		// Reduce ConfigOptions into a Map that joins collections
		const configMap = new Map();
		// Sort configs alphabetically such that config map will always return in the same order, with fdt always first
		// This is important to ensure that the config string to be written and compared against is always the same
		const sortedConfigs = Object.entries(configs).sort((a, b) => {
			if (a[0] === 'fdt') {
				return -1;
			}
			if (b[0] === 'fdt') {
				return 1;
			}
			return a[0].localeCompare(b[0]);
		});
		for (const [configKey, configValue] of sortedConfigs) {
			// If extra_os_cmdline is set, ignore legacy isolcpus
			if (configKey === 'isolcpus' && 'extra_os_cmdline' in configs) {
				continue;
			}

			const entry = ExtraUEnv.supportedConfigs[configKey];
			if (!entry) {
				// Unsupported config, skip
				continue;
			}
			const ENTRY_KEY = entry.key;
			const ENTRY_IS_COLLECTION = entry.collection;

			// Check if we have to build the value for the entry
			if (ENTRY_IS_COLLECTION) {
				if (configKey === ENTRY_KEY) {
					// When setting extra_os_cmdline directly, normalize and set the full value
					configMap.set(ENTRY_KEY, ExtraUEnv.normalizeOptionValue(configValue));
				} else if (!configMap.get(ENTRY_KEY)) {
					// extra_os_cmdline doesn't yet exist, set sub-option directly
					configMap.set(ENTRY_KEY, `${configKey}=${configValue}`);
				} else if (!configMap.get(ENTRY_KEY).includes(configKey)) {
					// extra_os_cmdline already exists, only add sub-option if not already set
					configMap.set(
						ENTRY_KEY,
						ExtraUEnv.normalizeOptionValue(
							`${configMap.get(ENTRY_KEY)} ${configKey}=${configValue}`,
						),
					);
				}
			} else {
				// Set the value of this config
				configMap.set(ENTRY_KEY, `${configValue}`);
			}
		}
		return configMap;
	}
}
