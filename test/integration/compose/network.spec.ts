import { expect } from 'chai';

import { Network } from '~/src/compose/network';
import { createNetwork, withMockerode } from '~/test-lib/mockerode';

import * as Docker from 'dockerode';
import { cleanupDocker } from '~/test-lib/docker-helper';

describe('compose/network: integration tests', () => {
	const docker = new Docker();
	after(async () => {
		await cleanupDocker({ docker });
	});

	describe('creating and removing networks', () => {
		// This tests the happy path on the engine, including create and remove
		it('creates a new network on the engine with the given data', async () => {
			const network = Network.fromComposeObject('default', 12345, 'deadbeef', {
				ipam: {
					driver: 'default',
					config: [
						{
							subnet: '172.20.0.0/16',
							ip_range: '172.20.10.0/24',
							gateway: '172.20.0.1',
						},
					],
					options: {},
				},
			});

			// Create the network
			await network.create();

			const dockerNetworkName = Network.generateDockerName(
				network.appUuid!,
				network.name,
			);
			// This should not throw
			const dockerNetwork = await docker
				.getNetwork(dockerNetworkName)
				.inspect();

			// Check that the create function was called with proper arguments
			expect(dockerNetwork).to.deep.include({
				Name: 'deadbeef_default',
				Driver: 'bridge',
				IPAM: {
					Driver: 'default',
					Config: [
						{
							Subnet: '172.20.0.0/16',
							IPRange: '172.20.10.0/24',
							Gateway: '172.20.0.1',
						},
					],
					Options: {},
				},
				EnableIPv6: false,
				Internal: false,
				Labels: {
					'io.balena.supervised': 'true',
					'io.balena.app-id': '12345',
				},
				Options: {},
			});

			// Test network removal
			await network.remove();

			// The network should no longer exist
			await expect(docker.getNetwork(dockerNetwork).inspect()).to.be.rejected;
		});

		it('throws the error if there is a problem while creating the network', async () => {
			await withMockerode(async (mockerode) => {
				const network = Network.fromComposeObject(
					'default',
					12345,
					'deadbeef',
					{
						ipam: {
							driver: 'default',
							config: [
								{
									subnet: '172.20.0.0/16',
									ip_range: '172.20.10.0/24',
									gateway: '172.20.0.1',
								},
							],
							options: {},
						},
					},
				);

				// Re-define the dockerode.createNetwork to throw
				mockerode.createNetwork.rejects('Unknown engine error');

				// Creating the network should fail
				return expect(network.create()).to.be.rejected;
			});
		});
	});

	describe('removing a network', () => {
		it('removes a legacy network from the engine if it exists', async () => {
			// Creates a legacy network
			await docker.createNetwork({ Name: '12345_default' });

			// Create a dummy network object
			const network = Network.fromComposeObject(
				'default',
				12345,
				'deadbeef',
				{},
			);

			// Perform the operation
			await network.remove();

			await expect(docker.getNetwork('12345_default').inspect()).to.be.rejected;
		});

		it('ignores the request if the given network does not exist on the engine', async () => {
			// Create a mock network to add to the mock engine
			await docker.createNetwork({
				Name: 'some_network',
			});

			// Create a dummy network object
			const network = Network.fromComposeObject(
				'default',
				12345,
				'deadbeef',
				{},
			);

			// This should not fail
			await expect(network.remove()).to.not.be.rejected;

			// We expect the network state to remain constant
			await expect(docker.getNetwork('some_network').inspect()).to.not.be
				.rejected;

			// Cleanup
			await docker.getNetwork('some_network').remove();
		});

		it('throws the error if there is a problem while removing the network', async () => {
			// Create a mock network to add to the mock engine
			const mockNetwork = createNetwork({
				Id: 'aaaaaaaa',
				Name: 'a173bdb734884b778f5cc3dffd18733e_default',
				Labels: {
					'io.balena.app-id': '12345',
				},
			});

			await withMockerode(
				async (mockerode) => {
					// We can change the return value of the mockerode removeNetwork
					// to have the remove operation fail
					mockerode.removeNetwork.throws({
						statusCode: 500,
						message: 'Failed to remove the network',
					});

					// Create a dummy network object
					const network = Network.fromComposeObject(
						'default',
						12345,
						'a173bdb734884b778f5cc3dffd18733e',
						{},
					);

					await expect(network.remove()).to.be.rejected;
				},
				{ networks: [mockNetwork] },
			);
		});
	});
});
