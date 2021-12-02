import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as config from '../config';
import * as constants from '../lib/constants';
import { getMetaOSRelease } from '../lib/os-release';
import { EnvVarObject } from '../types';
import { allBackends as Backends } from './backends';
import { ConfigOptions, ConfigBackend } from './backends/backend';

export async function getSupportedBackends(): Promise<ConfigBackend[]> {
	// Get required information to find supported backends
	const [deviceType, metaRelease] = await Promise.all([
		config.get('deviceType'),
		getMetaOSRelease(constants.hostOSVersionPath),
	]);
	// Return list of configurable backends that match this deviceType and metaRelease
	return Bluebird.filter(Backends, (backend: ConfigBackend) =>
		backend.matches(deviceType, metaRelease),
	);
}

export function envToBootConfig(
	configBackend: ConfigBackend | null,
	env: EnvVarObject,
): ConfigOptions {
	if (configBackend == null) {
		return {};
	}
	return _(env)
		.pickBy((_val, key) => configBackend.isBootConfigVar(key))
		.mapKeys((_val, key) => configBackend.processConfigVarName(key))
		.mapValues((val, key) =>
			configBackend.processConfigVarValue(key, val || ''),
		)
		.value();
}

export function bootConfigToEnv(
	configBackend: ConfigBackend,
	configOptions: ConfigOptions,
): EnvVarObject {
	return _(configOptions)
		.mapKeys((_val, key) => configBackend.createConfigVarName(key))
		.mapValues((val) => {
			if (_.isArray(val)) {
				return JSON.stringify(val).replace(/^\[(.*)\]$/, '$1');
			}
			return val;
		})
		.value();
}

export function filterNamespaceFromConfig(
	namespace: RegExp,
	conf: { [key: string]: any },
): { [key: string]: any } {
	return _.mapKeys(
		_.pickBy(conf, (_v, k) => {
			return namespace.test(k);
		}),
		(_v, k) => {
			return k.replace(namespace, '$1');
		},
	);
}
