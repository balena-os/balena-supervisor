import * as Promise from 'bluebird';
import * as childProcessSync from 'child_process';
import * as _ from 'lodash';

import * as constants from './constants';
import * as fsUtils from './fs-utils';
import { EnvVarObject } from './types';

const childProcess: any = Promise.promisifyAll(childProcessSync);

export interface ConfigOptions {
	[key: string]: string | string[];
}

export const rpiArrayConfigKeys = [
	'dtparam',
	'dtoverlay',
	'device_tree_param',
	'device_tree_overlay',
];

export const hostConfigConfigVarPrefix = 'RESIN_HOST_';
export const rPiBootConfigPrefix = hostConfigConfigVarPrefix + 'CONFIG_';
export const rPiConfigRegex = new RegExp('(' + _.escapeRegExp(rPiBootConfigPrefix) + ')(.+)');

export const bootMountPoint = constants.rootMountPoint + constants.bootMountPoint;

export function isRPiDeviceType(deviceType: string): boolean {
	return _.startsWith(deviceType, 'raspberry') || deviceType === 'fincm3';
}

export function isConfigDeviceType(deviceType: string): boolean {
	return isRPiDeviceType(deviceType);
}

export function bootConfigVarPrefix(deviceType: string): string {
	if (isRPiDeviceType(deviceType)) {
		return rPiBootConfigPrefix;
	} else {
		throw new Error(`No boot config var prefix for device type: ${deviceType}`);
	}
}

export function bootConfigVarRegex(deviceType: string): RegExp {
	if (isRPiDeviceType(deviceType)) {
		return rPiConfigRegex;
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
	} else {
		throw new Error(`No boot config exists for device type: ${deviceType}`);
	}
}

function getRpiBootConfig(): string {
	return bootMountPoint + '/config.txt';
}

export function parseBootConfig(deviceType: string, conf: string): ConfigOptions {
	if (isRPiDeviceType(deviceType)) {
		return parseRpiBootConfig(conf);
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

export function setBootConfig(deviceType: string, target: ConfigOptions): Promise<void> {
	if (isRPiDeviceType(deviceType)) {
		return setRpiBootConfig(target);
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

function remountAndWriteAtomic(file: string, data: string): Promise<void> {
	// TODO: Find out why the below Promise.resolve() is required
	// Here's the dangerous part:
	return Promise.resolve(childProcess.execAsync(`mount -t vfat -o remount,rw ${constants.bootBlockDevice} ${bootMountPoint}`))
		.then(() => {
			return fsUtils.writeFileAtomic(file, data);
		})
		.return();
}
