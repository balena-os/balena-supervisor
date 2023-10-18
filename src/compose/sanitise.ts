import * as _ from 'lodash';

import { ConfigMap, ServiceComposeConfig } from './types/service';

import log from '../lib/supervisor-console';

// TODO: Generate these fields from the interface we define
// in service-types.
const supportedComposeFields = [
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

export function sanitiseComposeConfig(
	composeConfig: ConfigMap,
): ServiceComposeConfig {
	const filtered: string[] = [];
	const toReturn = _.pickBy(composeConfig, (_v, k) => {
		const included = supportedComposeFields.includes(k);
		if (!included) {
			filtered.push(k);
		}
		return included;
	}) as ServiceComposeConfig;

	if (filtered.length > 0) {
		log.warn(
			`Ignoring unsupported or unknown compose fields: ${filtered.join(', ')}`,
		);
	}

	return toReturn;
}
