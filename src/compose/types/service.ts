import * as t from 'io-ts';
import type Dockerode from 'dockerode';
import { isAbsolute } from 'path';

import type { PortMap } from '../ports';

export interface ComposeHealthcheck {
	test: string | string[];
	interval?: string;
	timeout?: string;
	startPeriod?: string;
	retries?: number;
	disable?: boolean;
}

export interface ServiceHealthcheck {
	test: string[];
	interval?: number;
	timeout?: number;
	startPeriod?: number;
	retries?: number;
}

export interface ServiceNetworkDictionary {
	[networkName: string]: {
		aliases?: string[];
		ipv4Address?: string;
		ipv6Address?: string;
		linkLocalIps?: string[];
	};
}

// Any short syntax volume definition
const ShortDefinition = t.string;
export type ShortDefinition = t.TypeOf<typeof ShortDefinition>;

/**
 * Brands are io-ts utilities to refine a base type into something more specific.
 * For example, ShortMount's base type is a string, but ShortMount only matches strings with a colon.
 */
// Short syntax volumes or binds with a colon, indicating a host to container mapping
interface ShortMountBrand {
	readonly ShortMount: unique symbol;
}
export const ShortMount = t.brand(
	ShortDefinition,
	(s): s is t.Branded<string, ShortMountBrand> => s.includes(':'),
	'ShortMount',
);
type ShortMount = t.TypeOf<typeof ShortMount>;

// Short syntax volumes with a colon and an absolute host path
interface ShortBindBrand {
	readonly ShortBind: unique symbol;
}
export const ShortBind = t.brand(
	ShortMount,
	(s): s is t.Branded<ShortMount, ShortBindBrand> => {
		const [source] = s.split(':');
		return isAbsolute(source);
	},
	'ShortBind',
);

// Anonymous short syntax volumes (no colon)
interface ShortAnonymousVolumeBrand {
	readonly ShortAnonymousVolume: unique symbol;
}
export const ShortAnonymousVolume = t.brand(
	ShortDefinition,
	(s): s is t.Branded<string, ShortAnonymousVolumeBrand> => !ShortMount.is(s),
	'ShortAnonymousVolume',
);

// Named short syntax volumes
interface ShortNamedVolumeBrand {
	readonly ShortNamedVolume: unique symbol;
}
export const ShortNamedVolume = t.brand(
	ShortMount,
	(s): s is t.Branded<ShortMount, ShortNamedVolumeBrand> =>
		ShortMount.is(s) && !ShortBind.is(s),
	'ShortNamedVolume',
);

// https://docs.docker.com/compose/compose-file/compose-file-v2/#volumes
const LongRequired = t.type({
	type: t.keyof({ volume: null, bind: null, tmpfs: null }),
	target: t.string,
});
// LongOptional will not restrict definable options based on
// the required `type` property, similar to docker-compose's behavior
const LongOptional = t.partial({
	readOnly: t.boolean,
	volume: t.type({ nocopy: t.boolean }),
	bind: t.type({ propagation: t.string }),
	tmpfs: t.type({ size: t.number }),
});
const LongBase = t.intersection([LongRequired, LongOptional]);
type LongBase = t.TypeOf<typeof LongBase>;
const LongWithSource = t.intersection([
	LongRequired,
	LongOptional,
	t.type({ source: t.string }),
]);
type LongWithSource = t.TypeOf<typeof LongWithSource>;

// 'source' is optional for volumes. Volumes without source are interpreted as anonymous volumes
interface LongAnonymousVolumeBrand {
	readonly LongAnonymousVolume: unique symbol;
}
export const LongAnonymousVolume = t.brand(
	LongBase,
	(l): l is t.Branded<LongBase, LongAnonymousVolumeBrand> =>
		l.type === 'volume' && !('source' in l),
	'LongAnonymousVolume',
);

interface LongNamedVolumeBrand {
	readonly LongNamedVolume: unique symbol;
}
export const LongNamedVolume = t.brand(
	LongWithSource,
	(l): l is t.Branded<LongWithSource, LongNamedVolumeBrand> =>
		l.type === 'volume' && !isAbsolute(l.source),
	'LongNamedVolume',
);

// 'source' is required for binds
interface LongBindBrand {
	readonly LongBind: unique symbol;
}
export const LongBind = t.brand(
	LongWithSource,
	(l): l is t.Branded<LongWithSource, LongBindBrand> =>
		l.type === 'bind' && isAbsolute(l.source),
	'LongBind',
);
export type LongBind = t.TypeOf<typeof LongBind>;

// 'source' is disallowed for tmpfs
interface LongTmpfsBrand {
	readonly LongTmpfs: unique symbol;
}
export const LongTmpfs = t.brand(
	LongBase,
	(l): l is t.Branded<LongBase, LongTmpfsBrand> =>
		l.type === 'tmpfs' && !('source' in l),
	'LongTmpfs',
);

// Any long syntax volume definition
export const LongDefinition = t.union([
	LongAnonymousVolume,
	LongNamedVolume,
	LongBind,
	LongTmpfs,
]);
export type LongDefinition = t.TypeOf<typeof LongDefinition>;

type ServiceVolumeConfig = ShortDefinition | LongDefinition;

// This is the config directly from the compose file (after running it
// through _.camelCase)
export interface ServiceComposeConfig {
	// Used for converting these fields in a programmatic fashion
	// Unfortunately even keys known at compiler time don't work
	// with the type system, as least at the moment
	[key: string]: any;

	capAdd?: string[];
	capDrop?: string[];
	command?: string[] | string;
	cgroupParent?: string;
	devices?: string[];
	dns?: string | string[];
	dnsOpt?: string[];
	dnsSearch?: string | string[];
	tmpfs?: string | string[];
	entrypoint?: string | string[];
	environment?: { [envVarName: string]: string };
	extraHosts?: string[];
	groupAdd?: string[];
	healthcheck?: ComposeHealthcheck;
	image: string;
	init?: boolean;
	labels?: { [labelName: string]: string };
	running?: boolean;
	networkMode?: string;
	networks?: string[] | ServiceNetworkDictionary;
	pid?: string;
	pidsLimit?: number;
	ports?: string[];
	securityOpt?: string[];
	stopGracePeriod?: string;
	stopSignal?: string;
	sysctls?: { [name: string]: string };
	ulimits?: {
		[ulimitName: string]: number | { soft: number; hard: number };
	};
	usernsMode?: string;
	volumes?: ServiceVolumeConfig[];
	restart?: string;
	cpuShares?: number;
	cpuQuota?: number;
	cpus?: number;
	cpuset?: string;
	domainname?: string;
	hostname?: string;
	ipc?: string;
	macAddress?: string;
	memLimit?: string;
	memReservation?: string;
	oomKillDisable?: boolean;
	oomScoreAdj?: number;
	privileged?: boolean;
	profiles?: string[];
	readOnly?: boolean;
	shmSize?: string;
	user?: string;
	workingDir?: string;
	tty?: boolean;
}

// This is identical to ServiceComposeConfig, except for the
// cases where these values are represented by higher level types.
export interface ServiceConfig {
	portMaps: PortMap[];

	capAdd: string[];
	capDrop: string[];
	command: string[];
	cgroupParent: string;
	devices: DockerDevice[];
	deviceRequests: Dockerode.DeviceRequest[];
	dns: string | string[];
	dnsOpt: string[];
	dnsSearch: string | string[];
	tmpfs: string[];
	entrypoint: string | string[];
	environment: { [envVarName: string]: string };
	extraHosts: string[];
	groupAdd: string[];
	healthcheck: ServiceHealthcheck;
	image: string;
	labels: { [labelName: string]: string };
	running: boolean;
	networkMode: string;
	networks: {
		[networkName: string]: {
			aliases?: string[];
			ipv4Address?: string;
			ipv6Address?: string;
			linkLocalIps?: string[];
		};
	};
	pid: string;
	pidsLimit: number;
	securityOpt: string[];
	stopGracePeriod: number;
	stopSignal: string;
	sysctls: { [name: string]: string };
	ulimits: {
		[ulimitName: string]: { soft: number; hard: number };
	};
	usernsMode: string;
	volumes: ServiceVolumeConfig[];
	restart: string;
	cpuShares: number;
	cpuQuota: number;
	cpus: number;
	cpuset: string;
	domainname: string;
	hostname: string;
	ipc: string;
	init?: boolean;
	macAddress: string;
	memLimit: number;
	memReservation: number;
	oomKillDisable: boolean;
	oomScoreAdj: number;
	privileged: boolean;
	readOnly: boolean;
	shmSize: number;
	user: string;
	workingDir: string;
	tty: boolean;
}

export type ServiceConfigArrayField =
	| 'volumes'
	| 'devices'
	| 'capAdd'
	| 'capDrop'
	| 'dns'
	| 'dnsSearch'
	| 'dnsOpt'
	| 'tmpfs'
	| 'extraHosts'
	| 'ulimitsArray'
	| 'groupAdd'
	| 'securityOpt';

// The config directly from the application manager, which contains
// application information, plus the compose data
export interface ConfigMap {
	[name: string]: any;
}

// When creating a service from the compose data, we need to extend the labels
// and environment variables which more information, defined below. Note
// that these do not need to be provided when create the service object from
// the docker inspect call, because they would have already been set by then.
// TODO: Move these to a more appropriate location once more of the supervisor
// is typescript
export interface DeviceMetadata {
	imageInfo?: Dockerode.ImageInspectInfo;
	uuid: string | null;
	appName: string;
	version: string;
	deviceType: string;
	deviceArch: string;
	deviceApiKey: string;
	apiEndpoint: string;
	listenPort: number;
	apiSecret: string;
	supervisorApiHost: string;
	osVersion: string;
	hostname: string;
	hostPathExists: {
		modules: boolean;
		firmware: boolean;
	};
}

export interface DockerDevice {
	PathOnHost: string;
	PathInContainer: string;
	CgroupPermissions: string;
}

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

export interface Service {
	appId: number;
	appUuid?: string;
	imageId: number;
	config: ServiceConfig;
	serviceName: string;
	commit: string;
	releaseId: number;
	serviceId: number;
	imageName: string | null;
	containerId: string | null;
	exitErrorMessage: string | null;

	dependsOn: string[] | null;

	dockerImageId: string | null;
	// This looks weird, and it is. The lowercase statuses come from Docker,
	// except the dashboard takes these values and displays them on the dashboard.
	// What we should be doin is defining these container statuses, and have the
	// dashboard make these human readable instead. Until that happens we have
	// this halfways state of some captalised statuses, and others coming directly
	// from docker
	status: ServiceStatus;
	createdAt: Date | null;
	startedAt: Date | null;

	hasNetwork(networkName: string): boolean;
	hasVolume(volumeName: string): boolean;
	isEqualExceptForRunningState(
		service: Service,
		currentContainerIds: Dictionary<string>,
	): boolean;
	isEqualConfig(
		service: Service,
		currentContainerIds: Dictionary<string>,
	): boolean;
	hasNetworkMode(networkName: string): boolean;
	extraNetworksToJoin(): ServiceConfig['networks'];
	toDockerContainer(opts: {
		deviceName: string;
		containerIds: Dictionary<string>;
	}): Dockerode.ContainerCreateOptions;
	handoverCompleteFullPathsOnHost(): string[];
}
