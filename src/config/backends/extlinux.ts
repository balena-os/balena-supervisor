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

interface ExtlinuxFile {
	labels: {
		[labelName: string]: {
			[directive: string]: string;
		};
	};
	globals: { [directive: string]: string };
}

export class ExtlinuxConfigBackend extends DeviceConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}EXTLINUX_`;
	private static bootConfigPath = `${bootMountPoint}/extlinux/extlinux.conf`;

	public static bootConfigVarRegex = new RegExp(
		'(' + _.escapeRegExp(ExtlinuxConfigBackend.bootConfigVarPrefix) + ')(.+)',
	);

	private static supportedConfigKeys = ['isolcpus'];

	public matches(deviceType: string): boolean {
		return _.startsWith(deviceType, 'jetson-tx');
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		let confContents: string;

		try {
			confContents = await fs.readFile(
				ExtlinuxConfigBackend.bootConfigPath,
				'utf-8',
			);
		} catch {
			// In the rare case where the user might have deleted extlinux conf file between linux boot and supervisor boot
			// We do not have any backup to fallback too; warn the user of a possible brick
			throw new Error(
				'Could not find extlinux file. Device is possibly bricked',
			);
		}

		const parsedBootFile = ExtlinuxConfigBackend.parseExtlinuxFile(
			confContents,
		);

		// First find the default label name
		const defaultLabel = _.find(parsedBootFile.globals, (_v, l) => {
			if (l === 'DEFAULT') {
				return true;
			}
			return false;
		});

		if (defaultLabel == null) {
			throw new Error('Could not find default entry for extlinux.conf file');
		}

		const labelEntry = parsedBootFile.labels[defaultLabel];

		if (labelEntry == null) {
			throw new Error(
				`Cannot find default label entry (label: ${defaultLabel}) for extlinux.conf file`,
			);
		}

		// All configuration options come from the `APPEND` directive in the default label entry
		const appendEntry = labelEntry.APPEND;

		if (appendEntry == null) {
			throw new Error(
				'Could not find APPEND directive in default extlinux.conf boot entry',
			);
		}

		const conf: ConfigOptions = {};
		const values = appendEntry.split(' ');
		for (const value of values) {
			const parts = value.split('=');
			if (this.isSupportedConfig(parts[0])) {
				if (parts.length !== 2) {
					throw new Error(
						`Could not parse extlinux configuration entry: ${values} [value with error: ${value}]`,
					);
				}
				conf[parts[0]] = parts[1];
			}
		}

		return conf;
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// First get a representation of the configuration file, with all balena-supported configuration removed
		let confContents: string;

		try {
			confContents = await fs.readFile(
				ExtlinuxConfigBackend.bootConfigPath,
				'utf-8',
			);
		} catch {
			// In the rare case where the user might have deleted extlinux conf file between linux boot and supervisor boot
			// We do not have any backup to fallback too; warn the user of a possible brick
			throw new Error(
				'Could not find extlinux file. Device is possibly bricked',
			);
		}

		const extlinuxFile = ExtlinuxConfigBackend.parseExtlinuxFile(
			confContents.toString(),
		);
		const defaultLabel = extlinuxFile.globals.DEFAULT;
		if (defaultLabel == null) {
			throw new Error(
				'Could not find DEFAULT directive entry in extlinux.conf',
			);
		}
		const defaultEntry = extlinuxFile.labels[defaultLabel];
		if (defaultEntry == null) {
			throw new Error(
				`Could not find default extlinux.conf entry: ${defaultLabel}`,
			);
		}

		if (defaultEntry.APPEND == null) {
			throw new Error(
				`extlinux.conf APPEND directive not found for default entry: ${defaultLabel}, not sure how to proceed!`,
			);
		}

		const appendLine = _.filter(defaultEntry.APPEND.split(' '), (entry) => {
			const lhs = entry.split('=');
			return !this.isSupportedConfig(lhs[0]);
		});

		// Apply the new configuration to the "plain" append line above

		_.each(opts, (value, key) => {
			appendLine.push(`${key}=${value}`);
		});

		defaultEntry.APPEND = appendLine.join(' ');
		const extlinuxString = ExtlinuxConfigBackend.extlinuxFileToString(
			extlinuxFile,
		);

		await remountAndWriteAtomic(
			ExtlinuxConfigBackend.bootConfigPath,
			extlinuxString,
		);
	}

	public isSupportedConfig(configName: string): boolean {
		return _.includes(ExtlinuxConfigBackend.supportedConfigKeys, configName);
	}

	public isBootConfigVar(envVar: string): boolean {
		return _.startsWith(envVar, ExtlinuxConfigBackend.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string {
		return envVar.replace(ExtlinuxConfigBackend.bootConfigVarRegex, '$2');
	}

	public processConfigVarValue(_key: string, value: string): string {
		return value;
	}

	public createConfigVarName(configName: string): string {
		return `${ExtlinuxConfigBackend.bootConfigVarPrefix}${configName}`;
	}

	private static parseExtlinuxFile(confStr: string): ExtlinuxFile {
		const file: ExtlinuxFile = {
			globals: {},
			labels: {},
		};

		// Firstly split by line and filter any comments and empty lines
		let lines = confStr.split(/\r?\n/);
		lines = _.filter(lines, (l) => {
			const trimmed = _.trimStart(l);
			return trimmed !== '' && !_.startsWith(trimmed, '#');
		});

		let lastLabel = '';

		for (const line of lines) {
			const match = line.match(/^\s*(\w+)\s?(.*)$/);
			if (match == null) {
				log.warn(`Could not read extlinux entry: ${line}`);
				continue;
			}
			let directive = match[1].toUpperCase();
			let value = match[2];

			// Special handling for the MENU directive
			if (directive === 'MENU') {
				const parts = value.split(' ');
				directive = `MENU ${parts[0]}`;
				value = parts.slice(1).join(' ');
			}

			if (directive !== 'LABEL') {
				if (lastLabel === '') {
					// Global options
					file.globals[directive] = value;
				} else {
					// Label specific options
					file.labels[lastLabel][directive] = value;
				}
			} else {
				lastLabel = value;
				file.labels[lastLabel] = {};
			}
		}

		return file;
	}

	private static extlinuxFileToString(file: ExtlinuxFile): string {
		let ret = '';
		_.each(file.globals, (value, directive) => {
			ret += `${directive} ${value}\n`;
		});
		_.each(file.labels, (directives, key) => {
			ret += `LABEL ${key}\n`;
			_.each(directives, (value, directive) => {
				ret += `${directive} ${value}\n`;
			});
		});
		return ret;
	}
}
