import * as Dockerode from 'dockerode';
import Duration = require('duration-js');
import * as _ from 'lodash';
import { parse as parseCommand } from 'shell-quote';

import * as constants from '../lib/constants';
import { checkTruthy } from '../lib/validation';
import { Service } from './service';
import {
	ComposeHealthcheck,
	ConfigMap,
	DeviceMetadata,
	DockerDevice,
	ServiceComposeConfig,
	ServiceConfig,
	ServiceHealthcheck,
} from './types/service';

export function camelCaseConfig(
	literalConfig: ConfigMap,
): ServiceComposeConfig {
	const config = _.mapKeys(literalConfig, (_v, k) => _.camelCase(k));

	// Networks can either be an object or array, but given _.isObject
	// returns true for an array, we check the other way
	if (!_.isArray(config.networks)) {
		const networksTmp = _.cloneDeep(config.networks);
		_.each(networksTmp, (v, k) => {
			config.networks[k] = _.mapKeys(v, (_v, k) => _.camelCase(k));
		});
	}

	return config as ServiceComposeConfig;
}

export function parseMemoryNumber(
	valueAsString: string | null | undefined,
	defaultValue?: string,
): number {
	if (valueAsString == null) {
		if (defaultValue != null) {
			return parseMemoryNumber(defaultValue);
		}
		return 0;
	}
	const match = valueAsString.toString().match(/^([0-9]+)([bkmg]?)b?$/i);
	if (match == null) {
		if (defaultValue != null) {
			return parseMemoryNumber(defaultValue);
		}
		return 0;
	}
	const num = match[1];
	const pow: { [key: string]: number } = {
		'': 0,
		b: 0,
		B: 0,
		K: 1,
		k: 1,
		m: 2,
		M: 2,
		g: 3,
		G: 3,
	};
	return parseInt(num, 10) * 1024 ** pow[match[2]];
}

export const validRestartPolicies = [
	'no',
	'always',
	'on-failure',
	'unless-stopped',
];

export function createRestartPolicy(name?: string): string {
	if (name == null) {
		return 'always';
	}

	// Ensure that name is a string, otherwise the below could
	// throw
	if (!_.isString(name)) {
		console.log(
			`Warning: Non-string argument for restart field: ${name} - ignoring.`,
		);
		return 'always';
	}

	name = name.toLowerCase().trim();
	if (!_.includes(validRestartPolicies, name)) {
		return 'always';
	}

	if (name === 'no') {
		return '';
	}

	return name;
}

function processCommandString(command: string): string {
	return command.replace(/(\$)/g, '\\$1');
}

function processCommandParsedArrayElement(
	arg: string | { [key: string]: string },
): string {
	if (_.isString(arg)) {
		return arg;
	}
	if (arg.op === 'glob') {
		return arg.pattern;
	}
	return arg.op;
}

function commandAsArray(command: string | string[]): string[] {
	if (_.isString(command)) {
		return _.map(
			parseCommand(processCommandString(command)),
			processCommandParsedArrayElement,
		);
	}
	return command;
}

export function getCommand(
	composeCommand: string | string[] | null | undefined,
	imageInfo?: Dockerode.ImageInspectInfo,
): string[] {
	if (composeCommand != null) {
		return commandAsArray(composeCommand);
	}
	const imgCommand = _.get(imageInfo, 'Config.Cmd', []);
	return commandAsArray(imgCommand);
}

export function getEntryPoint(
	composeEntry: string | string[] | null | undefined,
	imageInfo?: Dockerode.ImageInspectInfo,
): string[] {
	if (composeEntry != null) {
		return commandAsArray(composeEntry);
	}
	const imgEntry = _.get(imageInfo, 'Config.Entrypoint', []);
	return commandAsArray(imgEntry);
}

// Note that the typings for the compose file stop signal
// say that this can only be a string, but the yaml parser
// could pass it through as a number, so support that here
export function getStopSignal(
	composeStop: string | number | null | undefined,
	imageInfo?: Dockerode.ImageInspectInfo,
): string {
	if (composeStop != null) {
		if (!_.isString(composeStop)) {
			return composeStop.toString();
		}
		return composeStop;
	}
	return _.get(imageInfo, 'Config.StopSignal', 'SIGTERM');
}

// TODO: Move healthcheck stuff into seperate module
export function dockerHealthcheckToServiceHealthcheck(
	healthcheck?: Dockerode.DockerHealthcheck,
): ServiceHealthcheck {
	if (healthcheck == null || _.isEmpty(healthcheck)) {
		return { test: ['NONE'] };
	}
	const serviceHC: ServiceHealthcheck = {
		test: healthcheck.Test,
	};

	if (healthcheck.Interval != null) {
		serviceHC.interval = healthcheck.Interval;
	}

	if (healthcheck.Timeout != null) {
		serviceHC.timeout = healthcheck.Timeout;
	}

	if (healthcheck.StartPeriod != null) {
		serviceHC.startPeriod = healthcheck.StartPeriod;
	}

	if (healthcheck.Retries != null) {
		serviceHC.retries = healthcheck.Retries;
	}

	return serviceHC;
}

function buildHealthcheckTest(test: string | string[]): string[] {
	if (_.isString(test)) {
		return ['CMD-SHELL', test];
	}
	return test;
}

function getNanoseconds(timeStr: string): number {
	return new Duration(timeStr).nanoseconds();
}

export function composeHealthcheckToServiceHealthcheck(
	healthcheck: ComposeHealthcheck | null | undefined,
): ServiceHealthcheck | {} {
	if (healthcheck == null) {
		return {};
	}

	if (healthcheck.disable) {
		return { test: ['NONE'] };
	}

	const serviceHC: ServiceHealthcheck = {
		test: buildHealthcheckTest(healthcheck.test),
	};

	if (healthcheck.interval != null) {
		serviceHC.interval = getNanoseconds(healthcheck.interval);
	}

	if (healthcheck.timeout != null) {
		serviceHC.timeout = getNanoseconds(healthcheck.timeout);
	}

	if (healthcheck.startPeriod != null) {
		serviceHC.startPeriod = getNanoseconds(healthcheck.startPeriod);
	}

	if (healthcheck.retries != null) {
		serviceHC.retries = healthcheck.retries;
	}

	return serviceHC;
}

export function getHealthcheck(
	composeHealthcheck: ComposeHealthcheck | null | undefined,
	imageInfo?: Dockerode.ImageInspectInfo,
): ServiceHealthcheck {
	// get the image info healtcheck
	const imageServiceHealthcheck = dockerHealthcheckToServiceHealthcheck(
		_.get(imageInfo, 'Config.Healthcheck', null),
	);
	const composeServiceHealthcheck = composeHealthcheckToServiceHealthcheck(
		composeHealthcheck,
	);

	// Overlay any compose healthcheck fields on the image healthchecks
	return _.assign(
		{ test: ['NONE'] },
		imageServiceHealthcheck,
		composeServiceHealthcheck,
	);
}

export function serviceHealthcheckToDockerHealthcheck(
	healthcheck: ServiceHealthcheck,
): Dockerode.DockerHealthcheck {
	return {
		Test: healthcheck.test,
		Interval: healthcheck.interval,
		Retries: healthcheck.retries,
		StartPeriod: healthcheck.startPeriod,
		Timeout: healthcheck.timeout,
	};
}

export function getWorkingDir(
	workingDir: string | null | undefined,
	imageInfo?: Dockerode.ImageInspectInfo,
): string {
	return (workingDir != null
		? workingDir
		: _.get(imageInfo, 'Config.WorkingDir', '')
	).replace(/(^.+)\/$/, '$1');
}

export function getUser(
	user: string | null | undefined,
	imageInfo?: Dockerode.ImageInspectInfo,
): string {
	return user != null ? user : _.get(imageInfo, 'Config.User', '');
}

export function sanitiseExposeFromCompose(portStr: string): string {
	if (/^[0-9]*$/.test(portStr)) {
		return `${portStr}/tcp`;
	}
	return portStr;
}

export function formatDevice(deviceStr: string): DockerDevice {
	const [pathOnHost, ...parts] = deviceStr.split(':');
	let [pathInContainer, cgroup] = parts;
	if (pathInContainer == null) {
		pathInContainer = pathOnHost;
	}
	if (cgroup == null) {
		cgroup = 'rwm';
	}
	return {
		PathOnHost: pathOnHost,
		PathInContainer: pathInContainer,
		CgroupPermissions: cgroup,
	};
}

// TODO: Export these strings to a constant lib, to
// enable changing them easily
// Mutates service
export function addFeaturesFromLabels(
	service: Service,
	options: DeviceMetadata,
): void {
	const setEnvVariables = function(key: string, val: string) {
		service.config.environment[`RESIN_${key}`] = val;
		service.config.environment[`BALENA_${key}`] = val;
	};
	if (checkTruthy(service.config.labels['io.balena.features.dbus'])) {
		service.config.volumes.push('/run/dbus:/host/run/dbus');
	}

	if (
		checkTruthy(service.config.labels['io.balena.features.kernel-modules']) &&
		options.hostPathExists.modules
	) {
		service.config.volumes.push('/lib/modules:/lib/modules');
	}

	if (
		checkTruthy(service.config.labels['io.balena.features.firmware']) &&
		options.hostPathExists.firmware
	) {
		service.config.volumes.push('/lib/firmware:/lib/firmware');
	}

	if (checkTruthy(service.config.labels['io.balena.features.balena-socket'])) {
		service.config.volumes.push(
			`${constants.dockerSocket}:${constants.dockerSocket}`,
		);
		if (service.config.environment['DOCKER_HOST'] == null) {
			service.config.environment['DOCKER_HOST'] = `unix://${
				constants.dockerSocket
			}`;
		}
		// We keep balena.sock for backwards compatibility
		if (constants.dockerSocket != '/var/run/balena.sock') {
			service.config.volumes.push(
				`${constants.dockerSocket}:/var/run/balena.sock`,
			);
		}
	}

	if (checkTruthy(service.config.labels['io.balena.features.balena-api'])) {
		setEnvVariables('API_KEY', options.deviceApiKey);
	}

	if (checkTruthy(service.config.labels['io.balena.features.supervisor-api'])) {
		setEnvVariables('SUPERVISOR_PORT', options.listenPort.toString());
		setEnvVariables('SUPERVISOR_API_KEY', options.apiSecret);
		if (service.config.networkMode === 'host') {
			setEnvVariables('SUPERVISOR_HOST', '127.0.0.1');
			setEnvVariables(
				'SUPERVISOR_ADDRESS',
				`http://127.0.0.1:${options.listenPort}`,
			);
		} else {
			setEnvVariables('SUPERVISOR_HOST', options.supervisorApiHost);
			setEnvVariables(
				'SUPERVISOR_ADDRESS',
				`http://${options.supervisorApiHost}:${options.listenPort}`,
			);
			service.config.networks[constants.supervisorNetworkInterface] = {};
		}
	} else {
		// Ensure that the user hasn't added 'supervisor0' to the service's list
		// of networks
		delete service.config.networks[constants.supervisorNetworkInterface];
	}
}

export function serviceUlimitsToDockerUlimits(
	ulimits: ServiceConfig['ulimits'] | null | undefined,
): Array<{ Name: string; Soft: number; Hard: number }> {
	const ret: Array<{ Name: string; Soft: number; Hard: number }> = [];
	_.each(ulimits, ({ soft, hard }, name) => {
		ret.push({ Name: name, Soft: soft, Hard: hard });
	});
	return ret;
}

export function serviceRestartToDockerRestartPolicy(
	restart: string,
): { Name: string; MaximumRetryCount: number } {
	return {
		Name: restart,
		MaximumRetryCount: 0,
	};
}

export function serviceNetworksToDockerNetworks(
	networks: ServiceConfig['networks'],
): Dockerode.ContainerCreateOptions['NetworkingConfig'] {
	const dockerNetworks: Dockerode.ContainerCreateOptions['NetworkingConfig'] = {
		EndpointsConfig: {},
	};

	_.each(networks, (net, name) => {
		// WHY??? This shouldn't be necessary, as we define it above...
		if (dockerNetworks.EndpointsConfig != null) {
			dockerNetworks.EndpointsConfig[name] = {};
			const conf = dockerNetworks.EndpointsConfig[name];
			conf.IPAMConfig = {};
			conf.Aliases = [];
			_.each(net, (v, k) => {
				switch (k) {
					case 'ipv4Address':
						conf.IPAMConfig.IPV4Address = v;
						break;
					case 'ipv6Address':
						conf.IPAMConfig.IPV6Address = v;
						break;
					case 'linkLocalIps':
						conf.IPAMConfig.LinkLocalIps = v;
						break;
					case 'aliases':
						conf.Aliases = v;
						break;
				}
			});
		}
	});

	return dockerNetworks;
}

export function dockerNetworkToServiceNetwork(
	dockerNetworks: Dockerode.ContainerInspectInfo['NetworkSettings']['Networks'],
): ServiceConfig['networks'] {
	// Take the input network object, filter out any nullish fields, extract things to
	// the correct level and return
	const networks: ServiceConfig['networks'] = {};

	_.each(dockerNetworks, (net, name) => {
		networks[name] = {};
		if (net.Aliases != null && !_.isEmpty(net.Aliases)) {
			networks[name].aliases = net.Aliases;
		}
		if (net.IPAMConfig != null) {
			const ipam = net.IPAMConfig;
			if (ipam.IPv4Address != null && !_.isEmpty(ipam.IPv4Address)) {
				networks[name].ipv4Address = ipam.IPv4Address;
			}
			if (ipam.IPv6Address != null && !_.isEmpty(ipam.IPv6Address)) {
				networks[name].ipv6Address = ipam.IPv6Address;
			}
			if (ipam.LinkLocalIps != null && !_.isEmpty(ipam.LinkLocalIps)) {
				networks[name].linkLocalIps = ipam.LinkLocalIps;
			}
		}
	});

	return networks;
}

// Mutates obj
export function normalizeNullValues(obj: Dictionary<any>): void {
	_.each(obj, (v, k) => {
		if (v == null) {
			obj[k] = undefined;
		} else if (_.isObject(v)) {
			normalizeNullValues(v);
		}
	});
}

export function normalizeLabels(labels: {
	[key: string]: string;
}): { [key: string]: string } {
	const legacyLabels = _.mapKeys(
		_.pickBy(labels, (_v, k) => _.startsWith(k, 'io.resin.')),
		(_v, k) => {
			return k.replace(/resin/g, 'balena'); // e.g. io.resin.features.resin-api -> io.balena.features.balena-api
		},
	);
	const balenaLabels = _.pickBy(labels, (_v, k) =>
		_.startsWith(k, 'io.balena.'),
	);
	const otherLabels = _.pickBy(
		labels,
		(_v, k) => !(_.startsWith(k, 'io.balena.') || _.startsWith(k, 'io.resin.')),
	);
	return _.assign({}, otherLabels, legacyLabels, balenaLabels);
}
