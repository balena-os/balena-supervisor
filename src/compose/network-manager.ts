import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { fs } from 'mz';

import * as constants from '../lib/constants';
import Docker from '../lib/docker-utils';
import { ENOENT, NotFoundError } from '../lib/errors';
import { Logger } from '../logger';
import { Network, NetworkOptions } from './network';

import log from '../lib/supervisor-console';

export class NetworkManager {
	private docker: Docker;
	private logger: Logger;

	constructor(opts: NetworkOptions) {
		this.docker = opts.docker;
		this.logger = opts.logger;
	}

	public getAll(): Bluebird<Network[]> {
		return this.getWithBothLabels().map((network: { Name: string }) => {
			return this.docker
				.getNetwork(network.Name)
				.inspect()
				.then(net => {
					return Network.fromDockerNetwork(
						{
							docker: this.docker,
							logger: this.logger,
						},
						net,
					);
				});
		});
	}

	public getAllByAppId(appId: number): Bluebird<Network[]> {
		return this.getAll().filter((network: Network) => network.appId === appId);
	}

	public get(network: { name: string; appId: number }): Bluebird<Network> {
		return Network.fromNameAndAppId(
			{
				logger: this.logger,
				docker: this.docker,
			},
			network.name,
			network.appId,
		);
	}

	public supervisorNetworkReady(): Bluebird<boolean> {
		return Bluebird.resolve(
			fs.stat(`/sys/class/net/${constants.supervisorNetworkInterface}`),
		)
			.then(() => {
				return this.docker
					.getNetwork(constants.supervisorNetworkInterface)
					.inspect();
			})
			.then(network => {
				return (
					network.Options['com.docker.network.bridge.name'] ===
						constants.supervisorNetworkInterface &&
					network.IPAM.Config[0].Subnet === constants.supervisorNetworkSubnet &&
					network.IPAM.Config[0].Gateway === constants.supervisorNetworkGateway
				);
			})
			.catchReturn(NotFoundError, false)
			.catchReturn(ENOENT, false);
	}

	public ensureSupervisorNetwork(): Bluebird<void> {
		const removeIt = () => {
			return Bluebird.resolve(
				this.docker.getNetwork(constants.supervisorNetworkInterface).remove(),
			).then(() => {
				return this.docker
					.getNetwork(constants.supervisorNetworkInterface)
					.inspect();
			});
		};

		return Bluebird.resolve(
			this.docker.getNetwork(constants.supervisorNetworkInterface).inspect(),
		)
			.then(net => {
				if (
					net.Options['com.docker.network.bridge.name'] !==
						constants.supervisorNetworkInterface ||
					net.IPAM.Config[0].Subnet !== constants.supervisorNetworkSubnet ||
					net.IPAM.Config[0].Gateway !== constants.supervisorNetworkGateway
				) {
					return removeIt();
				} else {
					return Bluebird.resolve(
						fs.stat(`/sys/class/net/${constants.supervisorNetworkInterface}`),
					)
						.catch(ENOENT, removeIt)
						.return();
				}
			})
			.catch(NotFoundError, () => {
				log.debug(`Creating ${constants.supervisorNetworkInterface} network`);
				return Bluebird.resolve(
					this.docker.createNetwork({
						Name: constants.supervisorNetworkInterface,
						Options: {
							'com.docker.network.bridge.name':
								constants.supervisorNetworkInterface,
						},
						IPAM: {
							Driver: 'default',
							Config: [
								{
									Subnet: constants.supervisorNetworkSubnet,
									Gateway: constants.supervisorNetworkGateway,
								},
							],
						},
					}),
				);
			});
	}

	private getWithBothLabels() {
		return Bluebird.join(
			this.docker.listNetworks({
				filters: {
					label: ['io.resin.supervised'],
				},
			}),
			this.docker.listNetworks({
				filters: {
					label: ['io.balena.supervised'],
				},
			}),
			(legacyNetworks, currentNetworks) => {
				return _.unionBy(currentNetworks, legacyNetworks, 'Id');
			},
		);
	}
}
