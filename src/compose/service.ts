import { detailedDiff as diff } from 'deep-object-diff';
import * as Dockerode from 'dockerode';
import Duration = require('duration-js');
import * as _ from 'lodash';
import * as path from 'path';

import { DockerPortOptions, PortMap } from './ports';
import * as ComposeUtils from './utils';
import * as updateLock from '../lib/update-lock';
import { sanitiseComposeConfig } from './sanitise';
import { pathOnRoot } from '../lib/host-utils';
import log from '../lib/supervisor-console';
import * as conversions from '../lib/conversions';
import { checkInt } from '../lib/validation';
import { InternalInconsistencyError } from '../lib/errors';

import { EnvVarObject } from '../types';
import {
	ServiceConfig,
	ServiceConfigArrayField,
	ServiceComposeConfig,
	ConfigMap,
	DeviceMetadata,
	DockerDevice,
	ShortMount,
	ShortBind,
	ShortAnonymousVolume,
	ShortNamedVolume,
	LongDefinition,
	LongTmpfs,
	LongBind,
	LongAnonymousVolume,
	LongNamedVolume,
} from './types/service';

const SERVICE_NETWORK_MODE_REGEX = /service:\s*(.+)/;
const CONTAINER_NETWORK_MODE_REGEX = /container:\s*(.+)/;

const unsupportedSecurityOpt = (opt: string) => /label=.*/.test(opt);

export type ServiceStatus =
	| 'Stopping'
	| 'Running'
	| 'Installing'
	| 'Installed'
	| 'Dead'
	| 'paused'
	| 'restarting'
	| 'removing'
	| 'exited';

export class Service {
	public appId: number;
	public appUuid?: string;
	public imageId: number;
	public config: ServiceConfig;
	public serviceName: string;
	public commit: string;
	public releaseId: number;
	public serviceId: number;
	public imageName: string | null;
	public containerId: string | null;
	public exitErrorMessage: string | null;

	public dependsOn: string[] | null;

	public dockerImageId: string | null;

	// This looks weird, and it is. The lowercase statuses come from Docker,
	// except the dashboard takes these values and displays them on the dashboard.
	// What we should be doin is defining these container statuses, and have the
	// dashboard make these human readable instead. Until that happens we have
	// this halfways state of some captalised statuses, and others coming directly
	// from docker
	public status: ServiceStatus;
	public createdAt: Date | null;

	private static configArrayFields: ServiceConfigArrayField[] = [
		'volumes',
		'devices',
		'capAdd',
		'capDrop',
		'dnsOpt',
		'tmpfs',
		'extraHosts',
		'expose',
		'ulimitsArray',
		'groupAdd',
		'securityOpt',
	];
	public static orderedConfigArrayFields: ServiceConfigArrayField[] = [
		'dns',
		'dnsSearch',
	];
	public static allConfigArrayFields: ServiceConfigArrayField[] =
		Service.configArrayFields.concat(Service.orderedConfigArrayFields);

	// A list of fields to ignore when comparing container configuration
	private static omitFields = [
		'networks',
		'running',
		'containerId',
		// This field is passed at container creation, but is not
		// reported on a container inspect, so we cannot use it
		// to compare containers
		'cpus',
		// These fields are special case, due to network_mode:service:<service>
		'networkMode',
		'hostname',
	].concat(Service.allConfigArrayFields);

	private constructor() {}

	// The type here is actually ServiceComposeConfig, except that the
	// keys must be camelCase'd first
	public static async fromComposeObject(
		appConfig: ConfigMap,
		options: DeviceMetadata,
	): Promise<Service> {
		const service = new Service();

		appConfig = {
			...appConfig,
			composition: ComposeUtils.camelCaseConfig(appConfig.composition || {}),
		};

		if (!appConfig.appId) {
			throw new InternalInconsistencyError('No app id for service');
		}
		const appId = checkInt(appConfig.appId);
		if (appId == null) {
			throw new InternalInconsistencyError('Malformed app id for service');
		}

		// Separate the application information from the docker
		// container configuration
		service.imageId = parseInt(appConfig.imageId, 10);
		service.serviceName = appConfig.serviceName;
		service.appId = appId;
		service.releaseId = parseInt(appConfig.releaseId, 10);
		service.serviceId = parseInt(appConfig.serviceId, 10);
		service.imageName = appConfig.image;
		service.createdAt = appConfig.createdAt;
		service.commit = appConfig.commit;
		service.appUuid = appConfig.appUuid;

		// dependsOn is used by other parts of the step
		// calculation so we delete it from the composition
		service.dependsOn = appConfig.composition?.dependsOn || null;
		delete appConfig.composition?.dependsOn;

		// Get remaining fields from appConfig
		const { image, running, labels, environment, composition } = appConfig;

		// Get rid of any extra values and report them to the user
		const config = sanitiseComposeConfig({
			image,
			running,
			...composition,

			// Ensure the top level label and environment definition is used
			labels: { ...(composition?.labels ?? {}), ...labels },
			environment: { ...(composition?.environment ?? {}), ...environment },
		});

		// Process some values into the correct format, delete them from
		// the original object, and add them to the defaults object below
		// We do it using defaults, as the types may be slightly different.
		// For any types which do not change, we change config[value] directly

		// First process the networks correctly
		let networks: ServiceConfig['networks'] = {};
		if (Array.isArray(config.networks)) {
			_.each(config.networks, (name) => {
				networks[name] = {};
			});
		} else if (_.isObject(config.networks)) {
			networks = config.networks || {};
		}
		// Prefix the network entries with the app id
		networks = _.mapKeys(networks, (_v, k) => `${service.appUuid}_${k}`);
		// Ensure that we add an alias of the service name
		networks = _.mapValues(networks, (v) => {
			if (v.aliases == null) {
				v.aliases = [];
			}
			const serviceName: string = service.serviceName || '';
			if (!_.includes(v.aliases, serviceName)) {
				v.aliases.push(serviceName);
			}
			return v;
		});
		delete config.networks;

		// memory strings
		const memLimit = ComposeUtils.parseMemoryNumber(config.memLimit, '0');
		const memReservation = ComposeUtils.parseMemoryNumber(
			config.memReservation,
			'0',
		);
		const shmSize = ComposeUtils.parseMemoryNumber(config.shmSize, '64m');
		delete config.memLimit;
		delete config.memReservation;
		delete config.shmSize;

		// time strings
		let stopGracePeriod = 10;
		if (config.stopGracePeriod != null) {
			stopGracePeriod = new Duration(config.stopGracePeriod).seconds();
		}
		delete config.stopGracePeriod;

		// ulimits
		const ulimits: ServiceConfig['ulimits'] = {};
		_.each(config.ulimits, (limit, name) => {
			if (typeof limit === 'number') {
				ulimits[name] = { soft: limit, hard: limit };
				return;
			}
			ulimits[name] = { soft: limit.soft, hard: limit.hard };
		});
		delete config.ulimits;

		// string or array of strings - normalise to an array
		if (typeof config.dns === 'string') {
			config.dns = [config.dns];
		}

		if (typeof config.dnsSearch === 'string') {
			config.dnsSearch = [config.dnsSearch];
		}

		// Special case network modes
		let serviceNetworkMode = false;
		if (config.networkMode != null) {
			const match = config.networkMode.match(SERVICE_NETWORK_MODE_REGEX);
			if (match != null) {
				// We need to add a depends on here to ensure that
				// the needed container has started up by the time
				// we try to start this service
				if (service.dependsOn == null) {
					service.dependsOn = [];
				}
				service.dependsOn.push(match[1]);
				serviceNetworkMode = true;
			} else if (CONTAINER_NETWORK_MODE_REGEX.test(config.networkMode)) {
				log.warn(
					'A network_mode referencing a container is not supported. Ignoring.',
				);
				delete config.networkMode;
			}
		} else {
			// Assign network_mode to a default value if necessary
			if (!_.isEmpty(networks)) {
				config.networkMode = _.keys(networks)[0];
			} else {
				config.networkMode = 'default';
			}
		}
		if (
			config.networkMode !== 'host' &&
			config.networkMode !== 'bridge' &&
			config.networkMode !== 'none'
		) {
			if (networks[config.networkMode!] == null && !serviceNetworkMode) {
				// The network mode has not been set explicitly
				config.networkMode = `${service.appUuid}_${config.networkMode}`;
				// If we don't have any networks, we need to
				// create the default with some default options
				networks[config.networkMode] = {
					aliases: [service.serviceName || ''],
				};
			}
		}

		// Add default environment variables and labels
		// We also omit any device name variables which may have
		// been input from the image (for example, if you docker
		// commit a container which has been run on a balena device)
		config.environment = Service.omitDeviceNameVars(
			Service.extendEnvVars(
				config.environment || {},
				options,
				service.appId || 0,
				service.appUuid!,
				service.serviceName || '',
			),
		);
		config.labels = ComposeUtils.normalizeLabels(
			Service.extendLabels(
				config.labels || {},
				options,
				service.appId || 0,
				service.serviceId || 0,
				service.serviceName || '',
				service.appUuid!, // appUuid will always exist on the target state
			),
		);

		// Any other special case handling
		if (config.networkMode === 'host' && !config.hostname) {
			config.hostname = options.hostname;
		}
		config.restart = ComposeUtils.createRestartPolicy(config.restart);
		config.command = ComposeUtils.getCommand(config.command, options.imageInfo);
		config.entrypoint = ComposeUtils.getEntryPoint(
			config.entrypoint,
			options.imageInfo,
		);
		config.stopSignal = ComposeUtils.getStopSignal(
			config.stopSignal,
			options.imageInfo,
		);
		config.workingDir = ComposeUtils.getWorkingDir(
			config.workingDir,
			options.imageInfo,
		);
		config.user = ComposeUtils.getUser(config.user, options.imageInfo);

		const healthcheck = ComposeUtils.getHealthcheck(
			config.healthcheck,
			options.imageInfo,
		);
		delete config.healthcheck;

		config.volumes = Service.extendAndSanitiseVolumes(
			config.volumes,
			options.imageInfo,
			service.appId,
			service.serviceName || '',
		);

		let portMaps: PortMap[] = [];
		if (config.ports != null) {
			portMaps = PortMap.fromComposePorts(config.ports);
		}
		delete config.ports;

		// get the exposed ports, both from the image and the compose file
		let expose: string[] = [];
		if (config.expose != null) {
			expose = _.map(config.expose, ComposeUtils.sanitiseExposeFromCompose);
		}
		const imageExposedPorts = _.get(
			options.imageInfo,
			'Config.ExposedPorts',
			{},
		);
		expose = expose.concat(_.keys(imageExposedPorts));
		// Also add any exposed ports which are implied from the portMaps
		const exposedFromPortMappings = _.flatMap(portMaps, (port) =>
			port.toExposedPortArray(),
		);
		expose = expose.concat(exposedFromPortMappings);
		expose = _.uniq(expose);
		delete config.expose;

		let devices: DockerDevice[] = [];
		if (config.devices != null) {
			devices = _.map(config.devices, ComposeUtils.formatDevice);
		}
		delete config.devices;

		// Sanity check the incoming boolean values
		config.oomKillDisable = Boolean(config.oomKillDisable);
		config.readOnly = Boolean(config.readOnly);
		if (config.tty != null) {
			config.tty = Boolean(config.tty);
		}

		if (Array.isArray(config.sysctls)) {
			config.sysctls = _.fromPairs(
				_.map(config.sysctls, (v) => _.split(v, '=')),
			);
		}
		config.sysctls = _.mapValues(config.sysctls, String);

		_.each(['cpuShares', 'cpuQuota', 'oomScoreAdj'], (key) => {
			const numVal = checkInt(config[key]);
			if (numVal) {
				config[key] = numVal;
			} else {
				delete config[key];
			}
		});

		if (config.cpus != null) {
			config.cpus = Math.round(Number(config.cpus) * 10 ** 9);
			if (_.isNaN(config.cpus)) {
				log.warn(
					`config.cpus value cannot be parsed. Ignoring.\n  Value:${config.cpus}`,
				);
				config.cpus = undefined;
			}
		}

		let tmpfs: string[] = [];
		if (config.tmpfs != null) {
			if (typeof config.tmpfs === 'string') {
				tmpfs = [config.tmpfs];
			} else {
				tmpfs = config.tmpfs;
			}
		}
		delete config.tmpfs;

		if (config.securityOpt != null) {
			const unsupported = (config.securityOpt || []).filter(
				unsupportedSecurityOpt,
			);
			if (unsupported.length > 0) {
				log.warn(`Ignoring unsupported security options: ${unsupported}`);
				config.securityOpt = (config.securityOpt || []).filter(
					(opt) => !unsupportedSecurityOpt(opt),
				);
			}
		}

		// Normalise the config before passing it to defaults
		ComposeUtils.normalizeNullValues(config);

		service.config = _.defaults(config, {
			portMaps,
			capAdd: [],
			capDrop: [],
			command: [],
			cgroupParent: '',
			devices,
			deviceRequests: [],
			dnsOpt: [],
			entrypoint: '',
			extraHosts: [],
			expose,
			networks,
			dns: [],
			dnsSearch: [],
			environment: {},
			labels: {},
			networkMode: '',
			ulimits,
			groupAdd: [],
			healthcheck,
			pid: '',
			pidsLimit: 0,
			securityOpt: [],
			stopGracePeriod,
			stopSignal: 'SIGTERM',
			sysctls: {},
			tmpfs,
			usernsMode: '',
			volumes: [],
			restart: 'always',
			cpuShares: 0,
			cpuQuota: 0,
			cpus: 0,
			cpuset: '',
			domainname: '',
			ipc: 'shareable',
			macAddress: '',
			memLimit,
			memReservation,
			oomKillDisable: false,
			oomScoreAdj: 0,
			privileged: false,
			readOnly: false,
			shmSize,
			hostname: '',
			user: '',
			workingDir: '',
			tty: true,
			running: true,
		});

		// If we have the docker image ID, we replace the image
		// with that
		if (options.imageInfo?.Id != null) {
			config.image = options.imageInfo.Id;
			service.dockerImageId = options.imageInfo.Id;
		}

		// Mutate service with extra features
		await ComposeUtils.addFeaturesFromLabels(service, options);

		return service;
	}

	public static fromDockerContainer(
		container: Dockerode.ContainerInspectInfo,
	): Service {
		const svc = new Service();

		if (container.State.Running) {
			svc.status = 'Running';
		} else if (container.State.Status === 'created') {
			svc.status = 'Installed';
		} else if (container.State.Status === 'dead') {
			svc.status = 'Dead';
		} else {
			// We know this cast as fine as we represent all of the status available
			// by docker in the ServiceStatus type
			svc.status = container.State.Status as ServiceStatus;
		}

		svc.createdAt = new Date(container.Created);
		svc.containerId = container.Id;
		svc.exitErrorMessage = container.State.Error;

		let hostname = container.Config.Hostname;
		if (hostname.length === 12 && _.startsWith(container.Id, hostname)) {
			// A hostname equal to the first part of the container ID actually
			// means no hostname was specified
			hostname = '';
		}

		let networks: ServiceConfig['networks'] = {};
		if (_.get(container, 'NetworkSettings.Networks', null) != null) {
			networks = ComposeUtils.dockerNetworkToServiceNetwork(
				container.NetworkSettings.Networks,
				svc.containerId,
			);
		}

		const ulimits: ServiceConfig['ulimits'] = {};
		_.each(container.HostConfig.Ulimits, ({ Name, Soft, Hard }) => {
			ulimits[Name] = { soft: Soft, hard: Hard };
		});

		const portMaps = PortMap.fromDockerOpts(container.HostConfig.PortBindings);
		let expose = _.flatMap(
			_.flatMap(portMaps, (p) => p.toDockerOpts().exposedPorts),
			_.keys,
		);
		if (container.Config.ExposedPorts != null) {
			expose = expose.concat(
				_.map(container.Config.ExposedPorts, (_v, k) => k.toString()),
			);
		}
		expose = _.uniq(expose);

		const tmpfs: string[] = Object.keys(container.HostConfig?.Tmpfs || {});

		const binds: string[] = _.uniq(
			([] as string[]).concat(
				container.HostConfig.Binds || [],
				Object.keys(container.Config?.Volumes || {}),
			),
		);

		const mounts: LongDefinition[] = (container.HostConfig?.Mounts || []).map(
			ComposeUtils.dockerMountToServiceMount,
		);

		const volumes: ServiceConfig['volumes'] = [...binds, ...mounts];

		// We cannot use || for this value, as the empty string is a
		// valid restart policy but will equate to null in an OR
		let restart = _.get(container.HostConfig.RestartPolicy, 'Name');
		if (restart == null) {
			restart = 'always';
		}

		// Define the service config with the same defaults that are used
		// when creating from a compose object, so comparisons will work
		// correctly
		// TODO: We have extended HostConfig interface to keep up with the
		// missing typings, but we cannot do the same the Config sub-object
		// as it is not defined as it's own type. We need to either recreate
		// the entire ContainerInspectInfo object, or upstream the extra
		// fields to DefinitelyTyped
		svc.config = {
			// The typings say that this is optional, but it's
			// always set by docker
			networkMode: container.HostConfig.NetworkMode!,

			portMaps,
			expose,
			hostname,
			command: container.Config.Cmd || '',
			entrypoint: container.Config.Entrypoint || '',
			volumes,
			image: container.Config.Image,
			environment: Service.omitDeviceNameVars(
				conversions.envArrayToObject(container.Config.Env || []),
			),
			privileged: container.HostConfig.Privileged || false,
			labels: ComposeUtils.normalizeLabels(container.Config.Labels || {}),
			running: container.State.Running,
			restart,
			capAdd: container.HostConfig.CapAdd || [],
			capDrop: container.HostConfig.CapDrop || [],
			devices: container.HostConfig.Devices || [],
			deviceRequests: container.HostConfig.DeviceRequests || [],
			networks,
			memLimit: container.HostConfig.Memory || 0,
			memReservation: container.HostConfig.MemoryReservation || 0,
			shmSize: container.HostConfig.ShmSize || 0,
			cpuShares: container.HostConfig.CpuShares || 0,
			cpuQuota: container.HostConfig.CpuQuota || 0,
			// Not present on a container inspect
			cpus: 0,
			cpuset: container.HostConfig.CpusetCpus || '',
			domainname: container.Config.Domainname || '',
			oomKillDisable: container.HostConfig.OomKillDisable || false,
			oomScoreAdj: container.HostConfig.OomScoreAdj || 0,
			dns: container.HostConfig.Dns || [],
			dnsSearch: container.HostConfig.DnsSearch || [],
			dnsOpt: container.HostConfig.DnsOptions || [],
			tmpfs,
			extraHosts: container.HostConfig.ExtraHosts || [],
			ulimits,
			stopSignal: (container.Config as any).StopSignal || 'SIGTERM',
			stopGracePeriod: (container.Config as any).StopTimeout || 10,
			healthcheck: ComposeUtils.dockerHealthcheckToServiceHealthcheck(
				(container.Config as any).Healthcheck || {},
			),
			readOnly: container.HostConfig.ReadonlyRootfs || false,
			sysctls: container.HostConfig.Sysctls || {},
			cgroupParent: container.HostConfig.CgroupParent || '',
			groupAdd: container.HostConfig.GroupAdd || [],
			pid: container.HostConfig.PidMode || '',
			pidsLimit: container.HostConfig.PidsLimit || 0,
			securityOpt: (container.HostConfig.SecurityOpt || []).filter(
				// The docker engine v20+ adds selinux security options depending
				// on the container configuration. Ignore those in the target state
				// comparison as selinux is not supported by balenaOS so those options
				// will not have any effect.
				// https://github.com/moby/moby/blob/master/daemon/create.go#L214
				(opt: string) => !unsupportedSecurityOpt(opt),
			),
			usernsMode: container.HostConfig.UsernsMode || '',
			ipc: container.HostConfig.IpcMode || '',
			macAddress: (container.Config as any).MacAddress || '',
			user: container.Config.User || '',
			workingDir: container.Config.WorkingDir || '',
			tty: container.Config.Tty || false,
		};

		const appId = checkInt(svc.config.labels['io.balena.app-id']);
		if (appId == null) {
			throw new InternalInconsistencyError(
				`Found a service with no appId! ${svc}`,
			);
		}
		svc.appId = appId;
		svc.appUuid = svc.config.labels['io.balena.app-uuid'];
		svc.serviceName = svc.config.labels['io.balena.service-name'];
		svc.serviceId = parseInt(svc.config.labels['io.balena.service-id'], 10);
		if (Number.isNaN(svc.serviceId)) {
			throw new InternalInconsistencyError(
				'Attempt to build Service class from container with malformed labels',
			);
		}
		const nameMatch = container.Name.match(/.*_(\d+)_(\d+)(?:_(.*?))?$/);
		if (nameMatch == null) {
			throw new InternalInconsistencyError(
				`Expected supervised container to have name '<serviceName>_<imageId>_<releaseId>_<commit>', got: ${container.Name}`,
			);
		}

		svc.imageId = parseInt(nameMatch[1], 10);
		svc.releaseId = parseInt(nameMatch[2], 10);
		svc.commit = nameMatch[3];
		svc.containerId = container.Id;
		svc.dockerImageId = container.Config.Image;

		return svc;
	}

	/**
	 * Here we try to reverse the fromComposeObject to the best of our ability, as
	 * this is used for the supervisor reporting it's own target state. Some of
	 * these values won't match in a 1-1 comparison, such as `devices`, as we lose
	 * some data about.
	 *
	 * @returns ServiceConfig
	 * @memberof Service
	 */
	public toComposeObject() {
		return this.config;
	}

	public toDockerContainer(opts: {
		deviceName: string;
		containerIds: Dictionary<string>;
	}): Dockerode.ContainerCreateOptions {
		const { binds, mounts, volumes } = this.getBindsMountsAndVolumes();
		const { exposedPorts, portBindings } = this.generateExposeAndPorts();

		const tmpFs: Dictionary<''> = this.config.tmpfs.reduce(
			(dict, tmp) => ({ ...dict, [tmp]: '' }),
			{},
		);

		const mainNetwork = _.pickBy(
			this.config.networks,
			(_v, k) => k === this.config.networkMode,
		) as ServiceConfig['networks'];

		const match = this.config.networkMode.match(SERVICE_NETWORK_MODE_REGEX);
		if (match != null) {
			const containerId = opts.containerIds[match[1]];
			if (!containerId) {
				throw new Error(
					`No container for network_mode: 'service: ${match[1]}'`,
				);
			}
			this.config.networkMode = `container:${containerId}`;
		}
		return {
			name: `${this.serviceName}_${this.imageId}_${this.releaseId}_${this.commit}`,
			Tty: this.config.tty,
			Cmd: this.config.command,
			Volumes: volumes,
			// Typings are wrong here, the docker daemon accepts a string or string[],
			Entrypoint: this.config.entrypoint as string,
			Env: conversions.envObjectToArray(
				_.assign(
					{
						RESIN_DEVICE_NAME_AT_INIT: opts.deviceName,
						BALENA_DEVICE_NAME_AT_INIT: opts.deviceName,
					},
					this.config.environment,
				),
			),
			ExposedPorts: exposedPorts,
			Image: this.config.image,
			Labels: this.config.labels,
			NetworkingConfig:
				ComposeUtils.serviceNetworksToDockerNetworks(mainNetwork),
			StopSignal: this.config.stopSignal,
			Domainname: this.config.domainname,
			Hostname: this.config.hostname,
			// Typings are wrong here, it says MacAddress is a bool (wtf?) but it is
			// in fact a string
			MacAddress: this.config.macAddress as any,
			User: this.config.user,
			WorkingDir: this.config.workingDir,
			HostConfig: {
				CapAdd: this.config.capAdd,
				CapDrop: this.config.capDrop,
				Binds: binds,
				Mounts: mounts,
				CgroupParent: this.config.cgroupParent,
				Devices: this.config.devices,
				DeviceRequests: this.config.deviceRequests,
				Dns: this.config.dns,
				DnsOptions: this.config.dnsOpt,
				DnsSearch: this.config.dnsSearch,
				PortBindings: portBindings,
				ExtraHosts: this.config.extraHosts,
				GroupAdd: this.config.groupAdd,
				NetworkMode: this.config.networkMode,
				PidMode: this.config.pid,
				PidsLimit: this.config.pidsLimit,
				SecurityOpt: this.config.securityOpt,
				Sysctls: this.config.sysctls,
				Ulimits: ComposeUtils.serviceUlimitsToDockerUlimits(
					this.config.ulimits,
				),
				RestartPolicy: ComposeUtils.serviceRestartToDockerRestartPolicy(
					this.config.restart,
				),
				CpuShares: this.config.cpuShares,
				CpuQuota: this.config.cpuQuota,
				// Type missing, and HostConfig isn't defined as a seperate object
				// so we cannot extend it easily
				CpusetCpus: this.config.cpuset,
				Memory: this.config.memLimit,
				MemoryReservation: this.config.memReservation,
				OomKillDisable: this.config.oomKillDisable,
				OomScoreAdj: this.config.oomScoreAdj,
				Privileged: this.config.privileged,
				ReadonlyRootfs: this.config.readOnly,
				ShmSize: this.config.shmSize,
				Tmpfs: tmpFs,
				UsernsMode: this.config.usernsMode,
				NanoCpus: this.config.cpus,
				IpcMode: this.config.ipc,
			} as Dockerode.ContainerCreateOptions['HostConfig'],
			Healthcheck: ComposeUtils.serviceHealthcheckToDockerHealthcheck(
				this.config.healthcheck,
			),
			StopTimeout: this.config.stopGracePeriod,
		};
	}

	public isEqualConfig(
		service: Service,
		currentContainerIds: Dictionary<string>,
	): boolean {
		// Check all of the networks for any changes
		let sameNetworks = true;
		_.each(service.config.networks, (network, name) => {
			if (this.config.networks[name] == null) {
				sameNetworks = false;
				return;
			}
			sameNetworks =
				sameNetworks && this.isSameNetwork(this.config.networks[name], network);
			if (!sameNetworks) {
				const currentNetwork = this.config.networks[name];
				const newNetwork = network;
				log.debug(
					`Networks do not match!\nCurrent network: \n${JSON.stringify(
						currentNetwork,
					)}\nNew network: \n${JSON.stringify(newNetwork)}`,
				);
			}
		});

		// Check the configuration for any changes
		const thisOmitted = _.omit(this.config, Service.omitFields);
		const otherOmitted = _.omit(service.config, Service.omitFields);
		let sameConfig = _.isEqual(thisOmitted, otherOmitted);
		const nonArrayEquals = sameConfig;

		// Because the service config does not have an index
		// field, we must first convert to unknown. We know that
		// this conversion is fine as the
		// Service.configArrayFields and
		// Service.orderedConfigArrayFields are defined as
		// fields inside of Service.config
		const arrayEq = ComposeUtils.compareArrayFields(
			this.config as unknown as Dictionary<unknown>,
			service.config as unknown as Dictionary<unknown>,
			Service.configArrayFields,
			Service.orderedConfigArrayFields,
		);
		sameConfig = sameConfig && arrayEq.equal;
		let differentArrayFields: string[] = [];
		if (!arrayEq.equal) {
			differentArrayFields = arrayEq.difference;
		}

		if (!(sameConfig && sameNetworks)) {
			// Add some console output for why a service is not matching
			// so that if we end up in a restart loop, we know exactly why
			log.debug(
				`Replacing container for service ${this.serviceName} because of config changes:`,
			);
			if (!nonArrayEquals) {
				// Try not to leak any sensitive information
				const diffObj = diff(thisOmitted, otherOmitted) as ServiceConfig;
				if (diffObj.environment != null) {
					diffObj.environment = _.mapValues(
						diffObj.environment,
						() => 'hidden',
					);
				}
				log.debug('  Non-array fields: ', JSON.stringify(diffObj));
			}
			if (differentArrayFields.length > 0) {
				log.debug('  Array Fields: ', differentArrayFields.join(','));
			}

			if (!sameNetworks) {
				log.debug('  Network changes detected');
			}
		}

		// Check the network mode separetely, as if it is a
		// service: network mode, the container id needs to be
		// checked against the running containers

		// When this function is called, it's with the current
		// state as a parameter and the target as the instance.
		// We shouldn't rely on that because it's not enforced
		// anywhere. For that reason we need to consider both
		// network_modes in the correct way
		let sameNetworkMode = false;
		for (const [a, b] of [
			[this.config.networkMode, service.config.networkMode],
			[service.config.networkMode, this.config.networkMode],
		]) {
			const aMatch = a.match(SERVICE_NETWORK_MODE_REGEX);
			const bMatch = b.match(SERVICE_NETWORK_MODE_REGEX);

			if (aMatch !== null) {
				if (bMatch === null) {
					const containerMatch = b.match(CONTAINER_NETWORK_MODE_REGEX);
					if (
						containerMatch !== null &&
						currentContainerIds[aMatch[1]] === containerMatch[1]
					) {
						sameNetworkMode = true;
						break;
					}
				} else {
					// They're both service entries, we shouldn't get here
					// but it's technically an equal configuration
					if (a === b) {
						sameNetworkMode = true;
						break;
					}
				}
			} else if (a === b && this.config.hostname === service.config.hostname) {
				// We consider the hostname when it's not a service: entry
				sameNetworkMode = true;
				break;
			}
		}

		return sameNetworks && sameConfig && sameNetworkMode;
	}

	public extraNetworksToJoin(): ServiceConfig['networks'] {
		return _.omit(this.config.networks, this.config.networkMode);
	}

	public isEqualExceptForRunningState(
		service: Service,
		currentContainerIds: Dictionary<string>,
	): boolean {
		return (
			this.isEqualConfig(service, currentContainerIds) &&
			this.commit === service.commit
		);
	}

	public isEqual(
		service: Service,
		currentContainerIds: Dictionary<string>,
	): boolean {
		return (
			this.isEqualExceptForRunningState(service, currentContainerIds) &&
			this.config.running === service.config.running
		);
	}

	public handoverCompleteFullPathsOnHost(): string[] {
		const lockPath = updateLock.lockPath(
			this.appId || 0,
			this.serviceName || '',
		);
		return pathOnRoot(
			...['handover-complete', 'resin-kill-me'].map((tail) =>
				path.join(lockPath, tail),
			),
		);
	}

	private getBindsMountsAndVolumes(): {
		binds: string[];
		mounts: Dockerode.MountSettings[];
		volumes: { [volName: string]: {} };
	} {
		const binds: string[] = [];
		const mounts: Dockerode.MountSettings[] = [];
		const volumes: { [volName: string]: {} } = {};

		for (const volume of this.config.volumes) {
			if (LongDefinition.is(volume)) {
				// Volumes with the long syntax are translated into Docker-accepted configs
				mounts.push(ComposeUtils.serviceMountToDockerMount(volume));
			} else {
				// Volumes with the string short syntax are acceptable as Docker configs as-is
				ShortMount.is(volume) ? binds.push(volume) : (volumes[volume] = {});
			}
		}

		return { binds, mounts, volumes };
	}

	private generateExposeAndPorts(): DockerPortOptions {
		const exposed: DockerPortOptions['exposedPorts'] = {};
		const ports: DockerPortOptions['portBindings'] = {};

		_.each(this.config.portMaps, (pmap) => {
			const { exposedPorts, portBindings } = pmap.toDockerOpts();
			_.merge(exposed, exposedPorts);
			_.mergeWith(ports, portBindings, (destVal, srcVal) => {
				if (destVal == null) {
					return srcVal;
				}
				return destVal.concat(srcVal);
			});
		});

		// We also want to merge the compose and image exposedPorts
		// into the list of exposedPorts
		const composeExposed: DockerPortOptions['exposedPorts'] = {};
		_.each(this.config.expose, (port) => {
			composeExposed[port] = {};
		});
		_.merge(exposed, composeExposed);

		return { exposedPorts: exposed, portBindings: ports };
	}

	private static extendEnvVars(
		environment: { [envVarName: string]: string } | null | undefined,
		options: DeviceMetadata,
		appId: number,
		appUuid: string,
		serviceName: string,
	): { [envVarName: string]: string } {
		const defaultEnv: { [envVarName: string]: string } = {};
		for (const namespace of ['BALENA', 'RESIN']) {
			_.assign(
				defaultEnv,
				_.mapKeys(
					{
						APP_ID: appId.toString(),
						APP_UUID: appUuid,
						APP_NAME: options.appName,
						SERVICE_NAME: serviceName,
						DEVICE_UUID: options.uuid,
						DEVICE_TYPE: options.deviceType,
						DEVICE_ARCH: options.deviceArch,
						HOST_OS_VERSION: options.osVersion,
						APP_LOCK_PATH: '/tmp/balena/updates.lock',
					},
					(_val, key) => `${namespace}_${key}`,
				),
			);
			defaultEnv[namespace] = '1';
		}
		defaultEnv['RESIN_SERVICE_KILL_ME_PATH'] = '/tmp/balena/handover-complete';
		defaultEnv['BALENA_SERVICE_HANDOVER_COMPLETE_PATH'] =
			'/tmp/balena/handover-complete';
		defaultEnv['USER'] = 'root';

		let env = _.defaults(environment, defaultEnv);
		const imageInfoEnv = _.get(options.imageInfo, 'Config.Env', []);
		env = _.defaults(env, conversions.envArrayToObject(imageInfoEnv));
		return env;
	}

	public hasNetwork(networkName: string) {
		// TODO; we could probably export network naming methods to another
		// module to avoid duplicate code
		// We don't know if this service is current or target state so we need
		// to check both appId and appUuid since the current service may still
		// have appId
		return (
			`${this.appUuid}_${networkName}` in this.config.networks ||
			`${this.appId}_${networkName}` in this.config.networks
		);
	}

	public hasNetworkMode(networkName: string) {
		// We don't know if this service is current or target state so we need
		// to check both appId and appUuid since the current service may still
		// have appId
		return (
			`${this.appUuid}_${networkName}` === this.config.networkMode ||
			`${this.appId}_${networkName}` === this.config.networkMode
		);
	}

	public hasVolume(volumeName: string) {
		return this.config.volumes.some((volumeDefinition) => {
			let source: string;

			if (LongNamedVolume.is(volumeDefinition)) {
				source = volumeDefinition.source;
			} else if (ShortNamedVolume.is(volumeDefinition)) {
				[source] = volumeDefinition.split(':');
			} else {
				return false;
			}

			return `${this.appId}_${volumeName}` === source;
		});
	}

	private isSameNetwork(
		current: ServiceConfig['networks'][0],
		target: ServiceConfig['networks'][0],
	): boolean {
		let sameNetwork = true;
		// Compare only the values which are defined in the target, as the current
		// values get set to defaults by docker
		if (target.aliases != null) {
			if (current.aliases == null) {
				sameNetwork = false;
			} else {
				const [currentAliases, targetAliases] = [
					current.aliases,
					target.aliases,
				];

				// Docker may add keep old container ids as aliases for a specific service after
				// restarts, this means that the target aliases really needs to be a subset of the
				// current aliases to prevent service restarts when re-applying the same target state
				sameNetwork =
					_.intersection(currentAliases, targetAliases).length ===
					targetAliases.length;
			}
		}
		if (target.ipv4Address != null) {
			sameNetwork =
				sameNetwork && _.isEqual(current.ipv4Address, target.ipv4Address);
		}
		if (target.ipv6Address != null) {
			sameNetwork =
				sameNetwork && _.isEqual(current.ipv6Address, target.ipv6Address);
		}
		if (target.linkLocalIps != null) {
			sameNetwork =
				sameNetwork && _.isEqual(current.linkLocalIps, target.linkLocalIps);
		}
		return sameNetwork;
	}

	private static omitDeviceNameVars(env: EnvVarObject) {
		return _.omit(env, [
			'RESIN_DEVICE_NAME_AT_INIT',
			'BALENA_DEVICE_NAME_AT_INIT',
		]);
	}

	private static extendLabels(
		labels: { [labelName: string]: string } | null | undefined,
		{ imageInfo }: DeviceMetadata,
		appId: number,
		serviceId: number,
		serviceName: string,
		appUuid: string,
	): { [labelName: string]: string } {
		let newLabels = {
			...labels,
			...{
				'io.balena.supervised': 'true',
				'io.balena.app-id': appId.toString(),
				'io.balena.service-id': serviceId.toString(),
				'io.balena.service-name': serviceName,
				'io.balena.app-uuid': appUuid,
			},
		};

		const imageLabels = _.get(imageInfo, 'Config.Labels', {});
		newLabels = _.defaults(newLabels, imageLabels);
		return newLabels;
	}

	private static extendAndSanitiseVolumes(
		composeVolumes: ServiceComposeConfig['volumes'],
		imageInfo: Dockerode.ImageInspectInfo | undefined,
		appId: number,
		serviceName: string,
	): ServiceConfig['volumes'] {
		let volumes: ServiceConfig['volumes'] = [];

		// namespace our volumes by appId
		const namespaceVolume = (volumeSource: string) =>
			`${appId}_${volumeSource.trim()}`;

		for (const volume of composeVolumes || []) {
			const isString = typeof volume === 'string';
			// Bind mounts are not allowed
			if (LongBind.is(volume) || ShortBind.is(volume)) {
				log.warn(
					`Ignoring invalid bind mount ${
						isString ? volume : JSON.stringify(volume)
					}`,
				);
			} else if (
				LongTmpfs.is(volume) ||
				LongAnonymousVolume.is(volume) ||
				ShortAnonymousVolume.is(volume)
			) {
				volumes.push(volume);
			} else if (LongNamedVolume.is(volume)) {
				volume.source = namespaceVolume(volume.source);
				volumes.push(volume);
			} else if (ShortNamedVolume.is(volume)) {
				const [source, target, mode] = (volume as string).split(':');
				let volumeDef = `${namespaceVolume(source)}:${target.trim()}`;
				if (mode != null) {
					volumeDef = `${volumeDef}:${mode.trim()}`;
				}
				volumes.push(volumeDef);
			} else {
				log.warn(
					`Ignoring invalid compose volume definition ${
						isString ? volume : JSON.stringify(volume)
					}`,
				);
			}
		}

		// Now add the default and image binds
		volumes = volumes.concat(Service.defaultBinds(appId, serviceName));
		volumes = _.union(_.keys(_.get(imageInfo, 'Config.Volumes')), volumes);

		return volumes;
	}

	private static defaultBinds(appId: number, serviceName: string): string[] {
		return [
			`${updateLock.lockPath(appId, serviceName)}:/tmp/resin`,
			`${updateLock.lockPath(appId, serviceName)}:/tmp/balena`,
		];
	}
}

export default Service;
