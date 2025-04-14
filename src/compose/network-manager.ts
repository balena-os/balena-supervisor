import _ from 'lodash';

import * as constants from '../lib/constants';
import { docker } from '../lib/docker-utils';
import { isNotFoundError } from '../lib/errors';
import logTypes = require('../lib/log-types');
import log from '../lib/supervisor-console';

import * as logger from '../logging';
import { Network } from './network';
import { ResourceRecreationAttemptError } from './errors';

export async function getAll(): Promise<Network[]> {
	const networks = await getWithBothLabels();
	return await Promise.all(
		networks.map(async (network: { Id: string }) => {
			const net = await docker.getNetwork(network.Id).inspect();
			return Network.fromDockerNetwork(net);
		}),
	);
}

async function get(network: {
	name: string;
	appUuid: string;
}): Promise<Network> {
	const dockerNet = await docker
		.getNetwork(Network.generateDockerName(network.appUuid, network.name))
		.inspect();
	return Network.fromDockerNetwork(dockerNet);
}

export async function create(network: Network) {
	try {
		const existing = await get({
			name: network.name,
			appUuid: network.appUuid!, // new networks will always have uuid
		});
		if (!network.isEqualConfig(existing)) {
			throw new ResourceRecreationAttemptError('network', network.name);
		}

		// We have a network with the same config and name
		// already created, we can skip this
	} catch (e: unknown) {
		if (!isNotFoundError(e)) {
			logger.logSystemEvent(logTypes.createNetworkError, {
				network: { name: network.name, appUuid: network.appUuid },
				error: e,
			});
			throw e;
		}

		// If we got a not found error, create the network
		await network.create();
	}
}

export async function remove(network: Network) {
	// We simply forward this to the network object, but we
	// add this method to provide a consistent interface
	await network.remove();
}

const {
	supervisorNetworkInterface: iface,
	supervisorNetworkGateway: gateway,
	supervisorNetworkSubnet: subnet,
} = constants;

export async function supervisorNetworkReady(): Promise<boolean> {
	try {
		// The inspect may fail even if the interface exist due to docker corruption
		const network = await docker.getNetwork(iface).inspect();
		// Verify podman-specific options
		const result =
			network.network_interface === iface &&
			network.subnets[0].subnet === subnet &&
			network.subnets[0].gateway === gateway;
		log.info(`supervisorNetworkReady() result: ${result}`);
		return true;
	} catch (e: unknown) {
		log.warn(
			`Failed to read docker configuration of network ${iface}:`,
			(e as Error).message,
		);
		// return false;
		return true;
	}
}

export async function ensureSupervisorNetwork(): Promise<void> {
	try {
		const net = await docker.getNetwork(iface).inspect();
		// Verify podman-specific options
		if (
			net.network_interface !== iface ||
			net.subnets[0].subnet !== subnet ||
			net.subnets[0].gateway !== gateway
		) {
			// Remove network if its configs aren't correct
			// await docker.getNetwork(iface).remove();
			// This will throw a 404 if network has been removed completely
			return await docker.getNetwork(iface).inspect();
		} else {
			log.info(`ensureSupervisorNetwork() podman OK`);
		}
	} catch (e: unknown) {
		if (!isNotFoundError(e)) {
			return;
		}

		// Determine the correct parameters to create a network like
		// /etc/containers/networks/supervisor0.json.
		log.warn(`ensureSupervisorNetwork() TODO podman create network`);
		// log.debug(`Creating ${iface} network`);
		// await docker.createNetwork({
		// 	Name: iface,
		// 	Options: {
		// 		'com.docker.network.bridge.name': iface,
		// 	},
		// 	IPAM: {
		// 		Driver: 'default',
		// 		Config: [
		// 			{
		// 				Subnet: subnet,
		// 				Gateway: gateway,
		// 			},
		// 		],
		// 	},
		// 	CheckDuplicate: true,
		// });
	}
}

async function getWithBothLabels() {
	const [legacyNetworks, currentNetworks] = await Promise.all([
		docker.listNetworks({
			filters: {
				label: ['io.resin.supervised'],
			},
		}),
		docker.listNetworks({
			filters: {
				label: ['io.balena.supervised'],
			},
		}),
	]);
	return _.unionBy(currentNetworks, legacyNetworks, 'Id');
}
