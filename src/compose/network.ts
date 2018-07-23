import * as Bluebird from 'bluebird';

import Docker = require('../lib/docker-utils');
import { NotFoundError } from '../lib/errors';
import logTypes = require('../lib/log-types');
import { checkInt } from '../lib/validation';


export interface NetworkOptions {
	docker: Docker;
	// TODO: Once the new logger is implemented and merged, type it
	// and use that type here
	logger: any;
}

export interface NetworkConfig {
}

// It appears the dockerode typings are incomplete,
// extend here for now.
interface NetworkInspect {
	Name: string;
}

export interface ComposeNetwork {
}

export class Network {

	public appId: number;
	public name: string;
	public config: NetworkConfig;

	private docker: Docker;
	// FIXME: Type this
	private logger: any;
	private networkOpts: NetworkOptions;

	private constructor(opts: NetworkOptions) {
		this.docker = opts.docker;
		this.logger = opts.logger;
		this.networkOpts = opts;
	}

	public static fromDockerodeNetwork(
		opts: NetworkOptions,
		network: NetworkInspect,
	): Network {

		const ret = new Network(opts);

		const match = network.Name.match(/^([0-9]+)_(.+)$/);
		if (match == null) {
			// FIXME: Type this properly
			throw new Error('Invalid network name: ' + network.Name);
		}
		const appId = checkInt(match[1]) || null;
		if (!appId) {
			throw new Error('Invalid appId: ' + appId);
		}
		ret.appId = appId;
		ret.name = match[2];
		ret.config = { };

		return ret;
	}

	public static async fromAppIdAndName(
		opts: NetworkOptions,
		name: string,
		appId: number,
	): Bluebird<Network> {
		const network = await opts.docker.getNetwork(`${appId}_${name}`).inspect();
		return Network.fromDockerodeNetwork(opts, network);
	}

	public static fromComposeObject(
		opts: NetworkOptions,
		name: string,
		appId: number,
		network: ComposeNetwork,
	): Network {
		const net = new Network(opts);
		net.name = name;
		net.appId = appId;
		net.config = network;

		return net;
	}

	public create(): Bluebird<void> {
		this.logger.logSystemEvent(logTypes.createNetwork, { network: { name: this.name } });

		return Network.fromAppIdAndName(this.networkOpts, this.name, this.appId)
			.then((current) => {
				if (!this.isEqualConfig(current)) {
					// FIXME: type this error
					throw new Error(
						`Trying to create network '${this.name}', but a network` +
						' with the same anme and different configuration exists',
					);
				}

				// We have a network with the same config and name already created -
				// we can skip this.
			})
			.catch(NotFoundError, () => {
				return this.docker.createNetwork({
					Name: this.getDockerName(),
					Labels: {
						'io.resin.supervised': 'true',
					},
				});
			})
			.tapCatch((err) => {
				this.logger.logSystemEvent(logTypes.createNetworkError, {
					network: { name: this.name, appId: this.appId },
					error: err,
				});
			});
	}

	public remove(): Bluebird<void> {
		this.logger.logSystemEvent(
			logTypes.removeNetwork,
			{ network: { name: this.name, appId: this.appId } },
		);

		return Bluebird.resolve(this.docker.getNetwork(this.getDockerName()).remove())
			.tapCatch((error) => {
				this.logger.logSystemEvent(
					logTypes.createNetworkError,
					{ network: { name: this.name, appId: this.appId }, error },
				);
			});

	}

	public isEqualConfig(_network: Network) {
		return true;
	}

	public getDockerName(): string {
		return `${this.appId}_${this.name}`;
	}

}
