import * as Promise from 'bluebird';
import * as childProcessSync from 'child_process';
import * as _ from 'lodash';
import { fs } from 'mz';

import * as constants from '../lib/constants';
import * as fsUtils from '../lib/fs-utils';

const childProcess: any = Promise.promisifyAll(childProcessSync);

export interface ConfigOptions {
	[key: string]: string | string[];
}

interface ExtlinuxFile {
	labels: {
		[labelName: string]: {
			[directive: string]: string;
		};
	};
	globals: { [directive: string]: string };
}

const bootMountPoint = `${constants.rootMountPoint}${constants.bootMountPoint}`;

function remountAndWriteAtomic(file: string, data: string): Promise<void> {
	// TODO: Find out why the below Promise.resolve() is required
	// Here's the dangerous part:
	return Promise.resolve(childProcess.execAsync(`mount -t vfat -o remount,rw ${constants.bootBlockDevice} ${bootMountPoint}`))
		.then(() => {
			return fsUtils.writeFileAtomic(file, data);
		})
		.return();
}

export abstract class DeviceConfigBackend {

	// Does this config backend support the given device type?
	public abstract matches(deviceType: string): boolean;

	// A function which reads and parses the configuration options from
	// specific boot config
	public abstract getBootConfig(): Promise<ConfigOptions>;

	// A function to take a set of options and flush to the configuration
	// file/backend
	public abstract setBootConfig(opts: ConfigOptions): Promise<void>;

	// Is the configuration option provided supported by this configuration
	// backend
	public abstract isSupportedConfig(configName: string): boolean;

	// Is this variable a boot config variable for this backend?
	public abstract isBootConfigVar(envVar: string): boolean;

	// Convert a configuration environment variable to a config backend
	// variable
	public abstract processConfigVarName(envVar: string): string;

	// Process the value if the environment variable, ready to be written to
	// the backend
	public abstract processConfigVarValue(key: string, value: string): string | string[];

	// Return the env var name for this config option
	public abstract createConfigVarName(configName: string): string;
}

export class RPiConfigBackend extends DeviceConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}CONFIG_`;
	private static bootConfigPath = `${bootMountPoint}/config.txt`;

	public static bootConfigVarRegex = new RegExp('(' + _.escapeRegExp(RPiConfigBackend.bootConfigVarPrefix) + ')(.+)');

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

	public getBootConfig(): Promise<ConfigOptions> {
		return Promise.resolve(fs.readFile(RPiConfigBackend.bootConfigPath, 'utf-8'))
			.then((confStr) => {

				const conf: ConfigOptions = { };
				const configStatements = confStr.split(/\r?\n/);

				for (const configStr of configStatements) {
					// Don't show warnings for comments and empty lines
					const trimmed = _.trimStart(configStr);
					if (_.startsWith(trimmed, '#') || trimmed === '') {
						continue;
					}
					let keyValue = /^([^=]+)=(.*)$/.exec(configStr);
					if (keyValue != null) {
						const [ , key, value ] = keyValue;
						if (!_.includes(RPiConfigBackend.arrayConfigKeys, key)) {
							conf[key] = value;
						} else {
							if (conf[key] == null) {
								conf[key] = [];
							}
							(conf[key] as string[]).push(value);
						}
						continue;
					}

					// Try the next regex instead
					keyValue = /^(initramfs) (.+)/.exec(configStr);
					if (keyValue != null) {
						const [ , key, value ] = keyValue;
						conf[key] = value;
					} else {
						console.log(`Warning - Could not parse config.txt entry: ${configStr}. Ignoring.`);
					}

				}

				return conf;
			});
	}

	public setBootConfig(opts: ConfigOptions): Promise<void> {
		let confStatements: string[] = [];

		_.each(opts, (value, key) => {
			if (key === 'initramfs') {
				confStatements.push(`${key} ${value}`);
			} else if(_.isArray(value)) {
				confStatements = confStatements.concat(_.map(value, (entry) => `${key}=${entry}`));
			} else {
				confStatements.push(`${key}=${value}`);
			}
		});

		const confStr = `${confStatements.join('\n')}\n`;

		return remountAndWriteAtomic(RPiConfigBackend.bootConfigPath, confStr);
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
				return [ value ];
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

export class ExtlinuxConfigBackend extends DeviceConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}EXTLINUX_`;
	private static bootConfigPath = `${bootMountPoint}/extlinux/extlinux.conf`;

	public static bootConfigVarRegex = new RegExp('(' + _.escapeRegExp(ExtlinuxConfigBackend.bootConfigVarPrefix) + ')(.+)');

	private static suppportedConfigKeys = [
		'isolcpus',
	];

	public matches(deviceType: string): boolean {
		return _.startsWith(deviceType, 'jetson-tx');
	}

	public getBootConfig(): Promise<ConfigOptions> {
		return Promise.resolve(fs.readFile(ExtlinuxConfigBackend.bootConfigPath, 'utf-8'))
			.then((confStr) => {
				const parsedBootFile = ExtlinuxConfigBackend.parseExtlinuxFile(confStr);

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
					throw new Error(`Cannot find default label entry (label: ${defaultLabel}) for extlinux.conf file`);
				}

				// All configuration options come from the `APPEND` directive in the default label entry
				const appendEntry = labelEntry.APPEND;

				if (appendEntry == null) {
					throw new Error('Could not find APPEND directive in default extlinux.conf boot entry');
				}

				const conf: ConfigOptions = { };
				const values = appendEntry.split(' ');
				for(const value of values) {
					const parts = value.split('=');
					if (this.isSupportedConfig(parts[0])) {
						if (parts.length !== 2) {
							throw new Error(`Could not parse extlinux configuration entry: ${values} [value with error: ${value}]`);
						}
						conf[parts[0]] = parts[1];
					}
				}

				return conf;
			});
	}

	public setBootConfig(opts: ConfigOptions): Promise<void> {
		// First get a representation of the configuration file, with all resin-supported configuration removed
		return Promise.resolve(fs.readFile(ExtlinuxConfigBackend.bootConfigPath))
			.then((data) => {
				const extlinuxFile = ExtlinuxConfigBackend.parseExtlinuxFile(data.toString());
				const defaultLabel = extlinuxFile.globals.DEFAULT;
				if (defaultLabel == null) {
					throw new Error('Could not find DEFAULT directive entry in extlinux.conf');
				}
				const defaultEntry = extlinuxFile.labels[defaultLabel];
				if (defaultEntry == null) {
					throw new Error(`Could not find default extlinux.conf entry: ${defaultLabel}`);
				}

				if (defaultEntry.APPEND == null) {
					throw new Error(`extlinux.conf APPEND directive not found for default entry: ${defaultLabel}, not sure how to proceed!`);
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
				const extlinuxString = ExtlinuxConfigBackend.extlinuxFileToString(extlinuxFile);

				return remountAndWriteAtomic(ExtlinuxConfigBackend.bootConfigPath, extlinuxString);
			});
	}

	public isSupportedConfig(configName: string): boolean {
		return _.includes(ExtlinuxConfigBackend.suppportedConfigKeys, configName);
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
			globals: { },
			labels: { },
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
				console.log('Warning - Could not read extlinux entry: ${line}');
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
				file.labels[lastLabel] = { };
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
