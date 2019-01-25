import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import Docker from '../lib/docker-utils';
import { InvalidAppIdError, NotFoundError } from '../lib/errors';
import logTypes = require('../lib/log-types');
import { checkInt } from '../lib/validation';
import { Logger } from '../logger';
import * as ComposeUtils from './utils';

import {
	DockerIPAMConfig,
	DockerNetworkConfig,
	NetworkConfig,
	NetworkInspect,
} from './types/network';

import {
	InvalidNetworkConfigurationError,
	InvalidNetworkNameError,
	ResourceRecreationAttemptError,
} from './errors';

export interface NetworkOptions {
	docker: Docker;
	logger: Logger;
}

export class Network {
	public appId: number;
	public name: string;
	public config: NetworkConfig;

	private docker: Docker;
	private logger: Logger;
	private networkOpts: NetworkOptions;

	private constructor(opts: NetworkOptions) {
		this.docker = opts.docker;
		this.logger = opts.logger;
		this.networkOpts = opts;
	}

	public static fromDockerNetwork(
		opts: NetworkOptions,
		network: NetworkInspect,
	): Network {
		const ret = new Network(opts);

		const match = network.Name.match(/^([0-9]+)_(.+)$/);
		if (match == null) {
			throw new InvalidNetworkNameError(network.Name);
		}
		const appId = checkInt(match[1]) || null;
		if (!appId) {
			throw new InvalidAppIdError(match[1]);
		}

		ret.appId = appId;
		ret.name = match[2];
		ret.config = {
			driver: network.Driver,
			ipam: {
				driver: network.IPAM.Driver,
				config: _.map(network.IPAM.Config, conf => {
					const newConf: NetworkConfig['ipam']['config'][0] = {};

					if (conf.Subnet != null) {
						newConf.subnet = conf.Subnet;
					}
					if (conf.Gateway != null) {
						newConf.gateway = conf.Gateway;
					}
					if (conf.IPRange != null) {
						newConf.ipRange = conf.IPRange;
					}
					if (conf.AuxAddress != null) {
						newConf.auxAddress = conf.AuxAddress;
					}

					return newConf;
				}),
				options: network.IPAM.Options == null ? {} : network.IPAM.Options,
			},
			enableIPv6: network.EnableIPv6,
			internal: network.Internal,
			labels: _.omit(ComposeUtils.normalizeLabels(network.Labels), [
				'io.balena.supervised',
			]),
			options: network.Options,
		};

		return ret;
	}

	public static async fromNameAndAppId(
		opts: NetworkOptions,
		name: string,
		appId: number,
	): Bluebird<Network> {
		const network = await opts.docker.getNetwork(`${appId}_${name}`).inspect();
		return Network.fromDockerNetwork(opts, network);
	}

	public static fromComposeObject(
		opts: NetworkOptions,
		name: string,
		appId: number,
		network: NetworkConfig,
	): Network {
		const net = new Network(opts);
		net.name = name;
		net.appId = appId;

		Network.validateComposeConfig(network);

		// Assign the default values for a network inspect,
		// so when we come to compare, it will match
		net.config = _.defaultsDeep(network, {
			driver: 'bridge',
			ipam: {
				driver: 'default',
				config: [],
				options: {},
			},
			enableIPv6: false,
			internal: false,
			labels: {},
			options: {},
		});
		net.config.labels = ComposeUtils.normalizeLabels(net.config.labels);

		return net;
	}

	public create(): Bluebird<void> {
		this.logger.logSystemEvent(logTypes.createNetwork, {
			network: { name: this.name },
		});

		return Network.fromNameAndAppId(this.networkOpts, this.name, this.appId)
			.then(current => {
				if (!this.isEqualConfig(current)) {
					throw new ResourceRecreationAttemptError('network', this.name);
				}

				// We have a network with the same config and name already created -
				// we can skip this.
			})
			.catch(NotFoundError, () => {
				return this.docker.createNetwork(this.toDockerConfig());
			})
			.tapCatch(err => {
				this.logger.logSystemEvent(logTypes.createNetworkError, {
					network: { name: this.name, appId: this.appId },
					error: err,
				});
			});
	}

	public toDockerConfig(): DockerNetworkConfig {
		return {
			Name: this.getDockerName(),
			Driver: this.config.driver,
			CheckDuplicate: true,
			IPAM: {
				Driver: this.config.ipam.driver,
				Config: _.map(this.config.ipam.config, conf => {
					const ipamConf: DockerIPAMConfig = {};
					if (conf.subnet != null) {
						ipamConf.Subnet = conf.subnet;
					}
					if (conf.gateway != null) {
						ipamConf.Gateway = conf.gateway;
					}
					if (conf.auxAddress != null) {
						ipamConf.AuxAddress = conf.auxAddress;
					}
					if (conf.ipRange != null) {
						ipamConf.IPRange = conf.ipRange;
					}
					return ipamConf;
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

	public remove(): Bluebird<void> {
		this.logger.logSystemEvent(logTypes.removeNetwork, {
			network: { name: this.name, appId: this.appId },
		});

		return Bluebird.resolve(
			this.docker.getNetwork(this.getDockerName()).remove(),
		).tapCatch(error => {
			this.logger.logSystemEvent(logTypes.createNetworkError, {
				network: { name: this.name, appId: this.appId },
				error,
			});
		});
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

	public getDockerName(): string {
		return `${this.appId}_${this.name}`;
	}

	private static validateComposeConfig(config: NetworkConfig): void {
		// Check if every ipam config entry has both a subnet and a gateway
		_.each(_.get(config, 'config.ipam.config', []), ({ subnet, gateway }) => {
			if (subnet == null || gateway == null) {
				throw new InvalidNetworkConfigurationError(
					'Network IPAM config entries must have both a subnet and gateway',
				);
			}
		});
	}
}
