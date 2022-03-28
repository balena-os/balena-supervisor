import * as _ from 'lodash';
import * as dockerode from 'dockerode';

import { docker } from '../lib/docker-utils';
import logTypes = require('../lib/log-types');
import * as logger from '../logger';
import log from '../lib/supervisor-console';
import * as ComposeUtils from './utils';

import { ComposeNetworkConfig, NetworkConfig } from './types/network';

import { InvalidNetworkNameError } from './errors';
import { InternalInconsistencyError } from '../lib/errors';

export class Network {
	public appId: number;
	public appUuid?: string;
	public name: string;
	public config: NetworkConfig;

	private constructor() {}

	private static deconstructDockerName(
		name: string,
	): { name: string; appId?: number; appUuid?: string } {
		const matchWithAppId = name.match(/^(\d+)_(\S+)/);
		if (matchWithAppId == null) {
			const matchWithAppUuid = name.match(/^([0-9a-f-A-F]{32,})_(\S+)/);

			if (!matchWithAppUuid) {
				throw new InvalidNetworkNameError(name);
			}

			const appUuid = matchWithAppUuid[1];
			return { name: matchWithAppUuid[2], appUuid };
		}

		const appId = parseInt(matchWithAppId[1], 10);
		if (isNaN(appId)) {
			throw new InvalidNetworkNameError(name);
		}

		return {
			appId,
			name: matchWithAppId[2],
		};
	}

	public static fromDockerNetwork(
		network: dockerode.NetworkInspectInfo,
	): Network {
		const ret = new Network();

		// Detect the name and appId from the inspect data
		const { name, appId, appUuid } = Network.deconstructDockerName(
			network.Name,
		);

		const labels = network.Labels ?? {};
		if (!appId && isNaN(parseInt(labels['io.balena.app-id'], 10))) {
			// This should never happen as supervised networks will always have either
			// the id or the label
			throw new InternalInconsistencyError(
				`Could not read app id from network: ${network.Name}`,
			);
		}

		ret.appId = appId ?? parseInt(labels['io.balena.app-id'], 10);
		ret.name = name;
		ret.appUuid = appUuid;

		const config = network.IPAM?.Config || [];

		ret.config = {
			driver: network.Driver,
			ipam: {
				driver: network.IPAM?.Driver ?? 'default',
				config: config.map((conf) => ({
					...(conf.Subnet && { subnet: conf.Subnet }),
					...(conf.Gateway && { gateway: conf.Gateway }),
					...(conf.IPRange && { ipRange: conf.IPRange }),
					...(conf.AuxAddress && { auxAddress: conf.AuxAddress }),
				})),
				options: network.IPAM?.Options ?? {},
			},
			enableIPv6: network.EnableIPv6,
			internal: network.Internal,
			labels: _.omit(ComposeUtils.normalizeLabels(labels), [
				'io.balena.supervised',
			]),
			options: network.Options ?? {},
		};

		return ret;
	}

	public static fromComposeObject(
		name: string,
		appId: number,
		appUuid: string,
		network: Partial<Omit<ComposeNetworkConfig, 'ipam'>> & {
			ipam?: Partial<ComposeNetworkConfig['ipam']>;
		},
	): Network {
		const net = new Network();
		net.name = name;
		net.appId = appId;
		net.appUuid = appUuid;

		Network.validateComposeConfig(network);

		const ipam = network.ipam ?? {};
		const driver = ipam.driver ?? 'default';
		const config = ipam.config ?? [];
		const options = ipam.options ?? {};

		net.config = {
			driver: network.driver || 'bridge',
			ipam: {
				driver,
				config: config.map((conf) => ({
					...(conf.subnet && { subnet: conf.subnet }),
					...(conf.gateway && { gateway: conf.gateway }),
					...(conf.ip_range && { ipRange: conf.ip_range }),
					// TODO: compose defines aux_addresses as a dict but dockerode and the
					// engine accepts a single AuxAddress. What happens when multiple addresses
					// are given?
					...(conf.aux_addresses && { auxAddress: conf.aux_addresses }),
				})) as ComposeNetworkConfig['ipam']['config'],
				options,
			},
			enableIPv6: network.enable_ipv6 || false,
			internal: network.internal || false,
			labels: {
				'io.balena.app-id': String(appId),
				...ComposeUtils.normalizeLabels(network.labels || {}),
			},
			options: network.driver_opts || {},
		};

		return net;
	}

	public toComposeObject(): ComposeNetworkConfig {
		return {
			driver: this.config.driver,
			driver_opts: this.config.options,
			enable_ipv6: this.config.enableIPv6,
			internal: this.config.internal,
			ipam: this.config.ipam,
			labels: this.config.labels,
		};
	}

	public async create(): Promise<void> {
		logger.logSystemEvent(logTypes.createNetwork, {
			network: { name: this.name, appUuid: this.appUuid },
		});

		await docker.createNetwork(this.toDockerConfig());
	}

	public toDockerConfig(): dockerode.NetworkCreateOptions {
		return {
			Name: Network.generateDockerName(this.appUuid!, this.name),
			Driver: this.config.driver,
			CheckDuplicate: true,
			Options: this.config.options,
			IPAM: {
				Driver: this.config.ipam.driver,
				Config: this.config.ipam.config.map((conf) => {
					return {
						...(conf.subnet && { Subnet: conf.subnet }),
						...(conf.gateway && { Gateway: conf.gateway }),
						...(conf.auxAddress && { AuxAddress: conf.auxAddress }),
						...(conf.ipRange && { IPRange: conf.ipRange }),
					};
				}),
				Options: this.config.ipam.options,
			},
			EnableIPv6: this.config.enableIPv6,
			Internal: this.config.internal,
			Labels: _.merge(
				{},
				{
					'io.balena.supervised': 'true',
				},
				this.config.labels,
			),
		};
	}

	public async remove() {
		logger.logSystemEvent(logTypes.removeNetwork, {
			network: { name: this.name, appUuid: this.appUuid },
		});

		// Find the network
		const [networkName] = (await docker.listNetworks())
			.filter((network) => {
				try {
					const { appId, appUuid, name } = Network.deconstructDockerName(
						network.Name,
					);
					return (
						name === this.name &&
						(appId === this.appId || appUuid === this.appUuid)
					);
				} catch {
					return false;
				}
			})
			.map((network) => network.Name);

		if (!networkName) {
			return;
		}

		try {
			await docker.getNetwork(networkName).remove();
		} catch (error) {
			logger.logSystemEvent(logTypes.removeNetworkError, {
				network: { name: this.name, appUuid: this.appUuid },
				error,
			});
			throw error;
		}
	}

	public isEqualConfig(network: Network): boolean {
		// don't compare the ipam.config if it's not present
		// in the target state (as it will be present in the
		// current state, due to docker populating it with
		// default or generated values)
		let configToCompare = this.config;
		if (network.config.ipam.config.length === 0) {
			configToCompare = _.cloneDeep(this.config);
			configToCompare.ipam.config = [];
		}

		return _.isEqual(configToCompare, network.config);
	}

	private static validateComposeConfig(
		config: Partial<Omit<ComposeNetworkConfig, 'ipam'>> & {
			ipam?: Partial<ComposeNetworkConfig['ipam']>;
		},
	): void {
		// Check if every ipam config entry has both a subnet and a gateway
		if (
			_.some(
				_.get(config, 'ipam.config', []),
				({ subnet, gateway }) => !subnet || !gateway,
			)
		) {
			log.warn(
				'Network IPAM config entries must have both a subnet and gateway defined.' +
					' Your network might not work properly otherwise.',
			);
		}
	}

	public static generateDockerName(appIdOrUuid: number | string, name: string) {
		return `${appIdOrUuid}_${name}`;
	}
}

export default Network;
