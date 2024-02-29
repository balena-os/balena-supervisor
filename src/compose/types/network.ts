import type { NetworkInspectInfo as DockerNetworkInspectInfo } from 'dockerode';

// TODO: ConfigOnly is part of @types/dockerode@v3.2.0, but that version isn't
// compatible with `resin-docker-build` which is used for `npm run sync`.
export interface NetworkInspectInfo extends DockerNetworkInspectInfo {
	ConfigOnly: boolean;
}

export interface ComposeNetworkConfig {
	driver: string;
	driver_opts: Dictionary<string>;
	ipam: {
		driver: string;
		config: Array<
			Partial<{
				subnet: string;
				ip_range: string;
				gateway: string;
				aux_addresses: Dictionary<string>;
			}>
		>;
		options: Dictionary<string>;
	};
	enable_ipv6: boolean;
	internal: boolean;
	labels: Dictionary<string>;
	config_only: boolean;
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
	configOnly: boolean;
}
