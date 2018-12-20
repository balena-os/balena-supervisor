// It appears the dockerode typings are incomplete,
// extend here for now.
// TODO: Upstream these to definitelytyped
export interface NetworkInspect {
	Name: string;
	Id: string;
	Created: string;
	Scope: string;
	Driver: string;
	EnableIPv6: boolean;
	IPAM: {
		Driver: string;
		Options: null | { [optName: string]: string };
		Config: Array<{
			Subnet: string;
			Gateway: string;
			IPRange?: string;
			AuxAddress?: string;
		}>;
	};
	Internal: boolean;
	Attachable: boolean;
	Ingress: boolean;
	Containers: {
		[containerId: string]: {
			Name: string;
			EndpointID: string;
			MacAddress: string;
			IPv4Address: string;
			IPv6Address: string;
		};
	};
	Options: { [optName: string]: string };
	Labels: { [labelName: string]: string };
}

export interface NetworkConfig {
	driver: string;
	ipam: {
		driver: string;
		config: Array<{
			subnet?: string;
			gateway?: string;
			ipRange?: string;
			auxAddress?: string;
		}>;
		options: { [optName: string]: string };
	};
	enableIPv6: boolean;
	internal: boolean;
	labels: { [labelName: string]: string };
	options: { [optName: string]: string };
}

export interface DockerIPAMConfig {
	Subnet?: string;
	IPRange?: string;
	Gateway?: string;
	AuxAddress?: string;
}

export interface DockerNetworkConfig {
	Name: string;
	Driver?: string;
	CheckDuplicate: boolean;
	IPAM?: {
		Driver?: string;
		Config?: DockerIPAMConfig[];
		Options?: Dictionary<string>;
	};
	Internal?: boolean;
	Attachable?: boolean;
	Ingress?: boolean;
	Options?: Dictionary<string>;
	Labels?: Dictionary<string>;
	EnableIPv6?: boolean;
}
