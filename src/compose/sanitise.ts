import * as _ from 'lodash';

import { ConfigMap, ServiceComposeConfig } from './types/service';
import { VolumeConfig } from './volume';

// TODO: Generate these fields from the interface we define
// in service-types.
// TODO: Replace this code with the validation that we can
// get from io-ts
const supportedServiceComposeFields = [
	'capAdd',
	'capDrop',
	'command',
	'cgroupParent',
	'devices',
	'dns',
	'dnsOpt',
	'dnsSearch',
	'tmpfs',
	'entrypoint',
	'environment',
	'expose',
	'extraHosts',
	'groupAdd',
	'healthcheck',
	'image',
	'init',
	'labels',
	'running',
	'networkMode',
	'networks',
	'pid',
	'pidsLimit',
	'ports',
	'securityOpt',
	'stopGracePeriod',
	'stopSignal',
	'storageOpt',
	'sysctls',
	'ulimits',
	'usernsMode',
	'volumes',
	'restart',
	'cpuShares',
	'cpuQuota',
	'cpus',
	'cpuset',
	'domainname',
	'hostname',
	'ipc',
	'macAddress',
	'memLimit',
	'memReservation',
	'oomKillDisable',
	'oomScoreAdj',
	'privileged',
	'readOnly',
	'shmSize',
	'user',
	'workingDir',
	'tty',
];

const supportedVolumeComposeFields = ['driverOpts', 'driver', 'labels'];

export function sanitiseServiceComposeConfig(
	composeConfig: ConfigMap,
): ServiceComposeConfig {
	return sanitiseConfig(supportedServiceComposeFields, composeConfig);
}

export function sanitiseVolumeComposeConfig(
	volumeConfig: ConfigMap,
): VolumeConfig {
	return sanitiseConfig(supportedVolumeComposeFields, volumeConfig);
}

function sanitiseConfig<T>(
	allowedConfig: string[],
	composeConfig: ConfigMap,
): T {
	const filtered: string[] = [];
	const toReturn = _.pickBy(composeConfig, (_v, k) => {
		const included = !_.includes(allowedConfig, k);
		if (!included) {
			filtered.push(k);
		}
		return included;
	}) as T;

	if (filtered.length > 0) {
		console.log(
			`Warning: Ignoring unsupported or unknown compose fields: ${filtered.join(
				',',
			)}`,
		);
	}

	return toReturn;
}
