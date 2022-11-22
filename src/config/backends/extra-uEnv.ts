import _ from 'lodash';

import { ConfigOptions, ConfigBackend } from './backend';
import * as constants from '../../lib/constants';
import log from '../../lib/supervisor-console';
import { ExtraUEnvError } from '../../lib/errors';
import { exists } from '../../lib/fs-utils';
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
	private static bootConfigPath = hostUtils.pathOnBoot(`extra_uEnv.txt`);

	private static entries: Record<EntryKey, Entry> = {
		custom_fdt_file: { key: 'custom_fdt_file', collection: false },
		extra_os_cmdline: { key: 'extra_os_cmdline', collection: true },
	};

	private static supportedConfigs: Dictionary<Entry> = {
		fdt: ExtraUEnv.entries['custom_fdt_file'],
		isolcpus: ExtraUEnv.entries['extra_os_cmdline'],
	};

	public static bootConfigVarRegex = new RegExp(
		'(?:' + _.escapeRegExp(ExtraUEnv.bootConfigVarPrefix) + ')(.+)',
	);

	public async matches(deviceType: string): Promise<boolean> {
		return (
			(deviceType.endsWith('-nano') ||
				deviceType.endsWith('-nano-emmc') ||
				deviceType.endsWith('-nano-2gb-devkit') ||
				deviceType.endsWith('-tx2') ||
				deviceType.includes('-tx2-nx') ||
				deviceType.includes('-agx-orin-') ||
				/imx8mm-var-som/.test(deviceType) ||
				/imx8mm?-var-dart/.test(deviceType)) &&
			(await exists(ExtraUEnv.bootConfigPath))
		);
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
		return await hostUtils.writeToBoot(
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

	private static parseOptions(configFile: string): ConfigOptions {
		// Exit early if configFile is empty
		if (configFile.length === 0) {
			return {};
		}
		// Split by line and filter any comments and empty lines
		const lines = configFile.split(LINE_REGEX);
		// Reduce lines to ConfigOptions
		return lines.reduce((options: ConfigOptions, line: string) => {
			const optionValues = line.match(OPTION_REGEX);
			if (optionValues == null) {
				log.warn(`Could not read extra_uEnv entry: ${line}`);
				return options;
			}
			// Merge new option with existing options
			return {
				...ExtraUEnv.parseOption(optionValues),
				...options,
			};
		}, {});
	}

	private static parseOption(optionArray: string[]): ConfigOptions {
		const [, KEY, VALUE] = optionArray;
		// Check if this key's value is a collection
		if (ExtraUEnv.entries[KEY as EntryKey]?.collection) {
			// Return split collection of options
			return ExtraUEnv.parseOptionCollection(VALUE);
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

	private static parseOptionCollection(
		collectionString: string,
	): ConfigOptions {
		return (
			collectionString
				// Split collection into individual options
				.split(' ')
				// Reduce list of option strings into ConfigOptions object
				.reduce((options: ConfigOptions, option: string) => {
					// Match optionValues to key=value regex
					const optionValues = option.match(OPTION_REGEX);
					// Check if option is only a key
					if (optionValues === null) {
						if (option !== '') {
							return { [option]: '', ...options };
						} else {
							log.warn(`Unable to set empty value option: ${option}`);
							return options;
						}
					}
					const [, KEY, VALUE] = optionValues;
					// Merge new option with existing options
					return { [KEY]: VALUE, ...options };
				}, {})
		);
	}

	private static async readBootConfigPath(): Promise<string> {
		try {
			return await hostUtils.readFromBoot(ExtraUEnv.bootConfigPath, 'utf-8');
		} catch {
			// In the rare case where the user might have deleted extra_uEnv conf file between linux boot and supervisor boot
			// We do not have any backup to fallback too; warn the user of a possible brick
			log.error(
				`Unable to read extra_uEnv file at: ${ExtraUEnv.bootConfigPath}`,
			);
			throw new ExtraUEnvError(
				'Could not find extra_uEnv file. Device is possibly bricked',
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
		for (const [configKey, configValue] of Object.entries(configs)) {
			const { key: ENTRY_KEY, collection: ENTRY_IS_COLLECTION } =
				ExtraUEnv.supportedConfigs[configKey];
			// Check if we have to build the value for the entry
			if (ENTRY_IS_COLLECTION) {
				configMap.set(
					ENTRY_KEY,
					ExtraUEnv.appendToCollection(
						configMap.get(ENTRY_KEY),
						configKey,
						configValue,
					),
				);
			} else {
				// Set the value of this config
				configMap.set(ENTRY_KEY, `${configValue}`);
			}
		}
		return configMap;
	}

	private static appendToCollection(
		collection: string = '',
		key: string,
		value: string | string[],
	) {
		return (
			// Start with existing collection and add a space
			(collection !== '' ? `${collection} ` : '') +
			// Append new key
			key +
			// Append value it's if not empty string
			(value !== '' ? `=${value}` : '')
		);
	}
}
