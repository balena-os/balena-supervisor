import * as _ from 'lodash';

import * as constants from '../lib/constants';
import { getMetaOSRelease } from '../lib/os-release';
import { EnvVarObject } from '../lib/types';
import { ExtlinuxConfigBackend } from './backends/extlinux';
import { ExtraUEnvConfigBackend } from './backends/extra-uEnv';
import { RPiConfigBackend } from './backends/raspberry-pi';
import { ConfigfsConfigBackend } from './backends/config-fs';
import { ConfigOptions, DeviceConfigBackend } from './backends/backend';

const configBackends = [
	new ExtlinuxConfigBackend(),
	new ExtraUEnvConfigBackend(),
	new RPiConfigBackend(),
	new ConfigfsConfigBackend(),
];

export const initialiseConfigBackend = async (deviceType: string) => {
	const backend = await getConfigBackend(deviceType);
	if (backend) {
		await backend.initialise();
		return backend;
	}
};

async function getConfigBackend(
	deviceType: string,
): Promise<DeviceConfigBackend | undefined> {
	// Some backends are only supported by certain release versions so pass in metaRelease
	const metaRelease = await getMetaOSRelease(constants.hostOSVersionPath);
	let matched;
	for (const backend of configBackends) {
		if (await backend.matches(deviceType, metaRelease)) {
			matched = backend;
		}
	}
	return matched;
}

export function envToBootConfig(
	configBackend: DeviceConfigBackend | null,
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

function filterNamespaceFromConfig(
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

export function formatConfigKeys(
	configBackend: DeviceConfigBackend | null,
	allowedKeys: string[],
	conf: { [key: string]: any },
): { [key: string]: any } {
	const isConfigType = configBackend != null;
	const namespaceRegex = /^BALENA_(.*)/;
	const legacyNamespaceRegex = /^RESIN_(.*)/;
	const confFromNamespace = filterNamespaceFromConfig(namespaceRegex, conf);
	const confFromLegacyNamespace = filterNamespaceFromConfig(
		legacyNamespaceRegex,
		conf,
	);
	const noNamespaceConf = _.pickBy(conf, (_v, k) => {
		return !_.startsWith(k, 'RESIN_') && !_.startsWith(k, 'BALENA_');
	});
	const confWithoutNamespace = _.defaults(
		confFromNamespace,
		confFromLegacyNamespace,
		noNamespaceConf,
	);

	return _.pickBy(confWithoutNamespace, (_v, k) => {
		return (
			_.includes(allowedKeys, k) ||
			(isConfigType && configBackend!.isBootConfigVar(k))
		);
	});
}
