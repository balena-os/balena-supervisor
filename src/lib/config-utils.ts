import * as Promise from 'bluebird';
import * as childProcessSync from 'child_process';
import * as _ from 'lodash';
import { fs } from 'mz';

import * as constants from './constants';
import * as fsUtils from './fs-utils';
import { EnvVarObject } from './types';

const childProcess: any = Promise.promisifyAll(childProcessSync);

export interface ConfigOptions {
	[key: string]: string | string[];
}

export interface ExtLinuxFile {
	labels: {
		[labelName: string]: {
			[directive: string]: string;
		};
	};
	globals: { [directive: string]: string };
}

export const rpiArrayConfigKeys = [
	'dtparam',
	'dtoverlay',
	'device_tree_param',
	'device_tree_overlay',
];

export const extlinuxSupportedConfig = [
	'isolcpus',
];

export const hostConfigConfigVarPrefix = 'RESIN_HOST_';
export const rPiBootConfigPrefix = hostConfigConfigVarPrefix + 'CONFIG_';
export const extlinuxBootConfigPrefix = hostConfigConfigVarPrefix + 'EXTLINUX_';
export const rPiConfigRegex = new RegExp('(' + _.escapeRegExp(rPiBootConfigPrefix) + ')(.+)');
export const extlinuxConfigRegex = new RegExp('(' + _.escapeRegExp(extlinuxBootConfigPrefix) + ')(.+)');

export const bootMountPoint = constants.rootMountPoint + constants.bootMountPoint;

export function isRPiDeviceType(deviceType: string): boolean {
	return _.startsWith(deviceType, 'raspberry') || deviceType === 'fincm3';
}

export function isExtlinuxDeviceType(deviceType: string): boolean {
	return _.startsWith(deviceType, 'jetson-tx');
}

export function isConfigDeviceType(deviceType: string): boolean {
	return isRPiDeviceType(deviceType) || isExtlinuxDeviceType(deviceType);
}

export function bootConfigVarPrefix(deviceType: string): string {
	if (isRPiDeviceType(deviceType)) {
		return rPiBootConfigPrefix;
	}	else if (isExtlinuxDeviceType(deviceType)) {
		return extlinuxBootConfigPrefix;
	} else {
		throw new Error(`No boot config var prefix for device type: ${deviceType}`);
	}
}

export function bootConfigVarRegex(deviceType: string): RegExp {
	if (isRPiDeviceType(deviceType)) {
		return rPiConfigRegex;
	} else if (isExtlinuxDeviceType(deviceType)) {
		return extlinuxConfigRegex;
	} else {
		throw new Error(`No boot config var regex for device type: ${deviceType}`);
	}
}

export function envToBootConfig(deviceType: string, env: EnvVarObject): ConfigOptions {
	if (!isConfigDeviceType(deviceType)) {
		return { };
	}
	const prefix = bootConfigVarPrefix(deviceType);
	const regex = bootConfigVarRegex(deviceType);

	let parsedEnv = _.pickBy(env, (_val: string, key: string) => {
		return _.startsWith(key, prefix);
	});
	parsedEnv = _.mapKeys(parsedEnv, (_val, key) => {
		return key.replace(regex, '$2');
	});
	parsedEnv = _.mapValues(parsedEnv, (val, key) => {
		if (isRPiDeviceType(deviceType)) {
			if (_.includes(rpiArrayConfigKeys, key)) {
				if (!_.startsWith(val, '"')) {
					return [ val ];
				} else {
					return JSON.parse(`[${val}]`);
				}
			}
		}
		return val;
	});

	return parsedEnv as ConfigOptions;
}

export function bootConfigToEnv(deviceType: string, config: ConfigOptions): EnvVarObject {
	const prefix = bootConfigVarPrefix(deviceType);
	const confWithEnvKeys = _.mapKeys(config, (_val, key) => {
		return prefix + key;
	});
	return _.mapValues(confWithEnvKeys, (val) => {
		if (_.isArray(val)) {
			return JSON.stringify(val).replace(/^\[(.*)\]$/, '$1');
		}
		return val;
	});
}

export function filterConfigKeys(
	deviceType: string,
	allowedKeys: string[],
	conf: { [key: string]: any },
): { [key: string]: any } {

	let isConfigType: boolean = false;
	let prefix: string;
	if (isConfigDeviceType(deviceType)) {
		prefix = bootConfigVarPrefix(deviceType);
		isConfigType = true;
	}
	return _.pickBy(conf, (_v, k) => {
		return _.includes(allowedKeys, k) || (isConfigType && _.startsWith(k, prefix));
	});
}

export function getBootConfigPath(deviceType: string): string {
	if (isRPiDeviceType(deviceType)) {
		return getRpiBootConfig();
	} else if (isExtlinuxDeviceType(deviceType)) {
		return getExtlinuxBootConfig();
	} else {
		throw new Error(`No boot config exists for device type: ${deviceType}`);
	}
}

function getRpiBootConfig(): string {
	return bootMountPoint + '/config.txt';
}

function getExtlinuxBootConfig(): string {
	return bootMountPoint + '/extlinux/extlinux.conf';
}

export function parseBootConfig(deviceType: string, conf: string): ConfigOptions {
	if (isRPiDeviceType(deviceType)) {
		return parseRpiBootConfig(conf);
	} else if (isExtlinuxDeviceType(deviceType)) {
		return parseExtlinuxBootConfig(conf);
	} else {
		throw new Error(`Cannot parse boot config for device type: ${deviceType}`);
	}
}

export function parseRpiBootConfig(confStr: string): ConfigOptions {
	const conf: ConfigOptions = { };
	const configStatements = confStr.split(/\r?\n/);

	for (const configStr of configStatements) {
		// Don't show warnings for comments and empty lines
		const trimmed = _.trimStart(configStr);
		if (_.startsWith(trimmed, '#') || trimmed === '') {
			continue;
		}
		let keyValue = /^([^#=]+)=(.+)/.exec(configStr);
		if (keyValue != null) {
			if (!_.includes(rpiArrayConfigKeys, keyValue[1])) {
				conf[keyValue[1]] = keyValue[2];
			} else {
				const key = keyValue[1];
				if (conf[key] == null) {
					conf[key] = [];
				}
				(conf[key] as string[]).push(keyValue[2]);
			}
		} else {
			keyValue = /^(initramfs) (.+)/.exec(configStr);
			if (keyValue != null) {
				conf[keyValue[1]] = keyValue[2];
			} else {
				console.log(`Warning - Could not parse config.txt entry: ${configStr}. Ignoring.`);
			}
		}
	}

	return conf;
}

export function parseExtlinuxBootConfig(confStr: string): ConfigOptions {
	const parsedBootFile = parseExtlinuxFile(confStr);

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
		if (isSupportedExtlinuxConfig(parts[0])) {
			conf[parts[0]] = parts[1];
		}
	}

	return conf;
}

export function parseExtlinuxFile(confStr: string): ExtLinuxFile {
	const file: ExtLinuxFile = {
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
			directive = 'MENU ' + parts[0];
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

export function setBootConfig(deviceType: string, target: ConfigOptions): Promise<void> {
	if (isRPiDeviceType(deviceType)) {
		return setRpiBootConfig(target);
	} else if (isExtlinuxDeviceType(deviceType)) {
		return setExtlinuxBootConfig(target);
	} else {
		throw new Error(`Could not set boot config for non-boot config device: ${deviceType}`);
	}
}

function setRpiBootConfig(target: ConfigOptions): Promise<void> {
	let confStatements: string[] = [];

	_.each(target, (value, key) => {

		if (key === 'initramfs') {
			confStatements.push(`${key} ${value}`);
		} else if(_.isArray(value)) {
			confStatements = confStatements.concat(_.map(value, (entry) => `${key}=${entry}`));
		} else {
			confStatements.push(`${key}=${value}`);
		}
	});

	return remountAndWriteAtomic(getRpiBootConfig(), confStatements.join('\n') + '\n');
}

function setExtlinuxBootConfig(target: ConfigOptions): Promise<void> {
	// First get a representation of the configuration file, with all resin-supported configuration removed
	return Promise.resolve(fs.readFile(getExtlinuxBootConfig()))
		.then((data) => {
			const extlinuxFile = parseExtlinuxFile(data.toString());
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
				return !isSupportedExtlinuxConfig(lhs[0]);
			});

			// Apply the new configuration to the "plain" append line above

			_.each(target, (value, key) => {
				appendLine.push(`${key}=${value}`);
			});

			defaultEntry.APPEND = appendLine.join(' ');
			const extlinuxString = extlinuxFileToString(extlinuxFile);

			return remountAndWriteAtomic(getExtlinuxBootConfig(), extlinuxString);
		});
}

function remountAndWriteAtomic(file: string, data: string): Promise<void> {
	// TODO: Find out why the below Promise.resolve() is required
	// Here's the dangerous part:
	return Promise.resolve(childProcess.execAsync(`mount -t vfat -o remount,rw ${constants.bootBlockDevice} ${bootMountPoint}`))
		.then(() => {
			return fsUtils.writeFileAtomic(file, data);
		})
		.return();
}

function isSupportedExtlinuxConfig(configName: string): boolean {
	// Currently the supported configuration values come in the form key=value
	return _.includes(extlinuxSupportedConfig, configName);
}

function extlinuxFileToString(file: ExtLinuxFile): string {
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
