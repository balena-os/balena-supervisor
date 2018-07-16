import * as _ from 'lodash';

import { EnvVarObject } from '../lib/types';
import {
	ConfigOptions,
	DeviceConfigBackend,
	ExtlinuxConfigBackend,
	RPiConfigBackend,
} from './backend';


const configBackends = [
	new ExtlinuxConfigBackend(),
	new RPiConfigBackend(),
];

export function isConfigDeviceType(deviceType: string): boolean {
	return getConfigBackend(deviceType) != null;
}

export function getConfigBackend(deviceType: string): DeviceConfigBackend | undefined {
	return _.find(configBackends, (backend) => backend.matches(deviceType));
}

export function envToBootConfig(
	configBackend: DeviceConfigBackend | null,
	env: EnvVarObject,
): ConfigOptions {

	if (configBackend == null) {
		return { };
	}

	return _(env)
		.pickBy((_val, key) => configBackend.isBootConfigVar(key))
		.mapKeys((_val, key) => configBackend.processConfigVarName(key))
		.mapValues((val, key) => configBackend.processConfigVarValue(key, val || ''))
		.value();
}

export function bootConfigToEnv(
	configBackend: DeviceConfigBackend,
	config: ConfigOptions,
): EnvVarObject {

	return _(config)
		.mapKeys((_val, key) => configBackend.createConfigVarName(key))
		.mapValues((val) => {
			if (_.isArray(val)) {
				return JSON.stringify(val).replace(/^\[(.*)\]$/, '$1');
			}
			return val;
		})
		.value();
}

export function filterConfigKeys(
	configBackend: DeviceConfigBackend | null,
	allowedKeys: string[],
	conf: { [key: string]: any },
): { [key: string]: any } {

	const isConfigType = configBackend != null;

	return _.pickBy(conf, (_v, k) => {
		return _.includes(allowedKeys, k) || (isConfigType && configBackend!.isBootConfigVar(k));
	});
}
