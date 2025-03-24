import { expect } from 'chai';
import Docker from 'dockerode';
import type { TargetStateV2 } from '~/lib/legacy';
import request from 'supertest';
import { setTimeout as delay } from 'timers/promises';
import { exec } from '~/lib/fs-utils';

const BALENA_SUPERVISOR_ADDRESS =
	process.env.BALENA_SUPERVISOR_ADDRESS || 'http://balena-supervisor:48484';

const getCurrentState = async () =>
	await request(BALENA_SUPERVISOR_ADDRESS)
		.get('/v2/local/target-state')
		.expect(200)
		.then(({ body }) => body.state.local);

const setTargetState = async (
	target: Omit<TargetStateV2['local'], 'name'>,
	timeout = 0,
) => {
	const { name, config } = await getCurrentState();
	const targetState = {
		local: {
			name,
			config,
			apps: target.apps,
		},
	};

	await request(BALENA_SUPERVISOR_ADDRESS)
		.post('/v2/local/target-state')
		.set('Content-Type', 'application/json')
		.send(JSON.stringify(targetState))
		.expect(200);

	const waitApplied = async () => {
		// Wait for the app state to be applied
		while ((await getStatus()).appState !== 'applied') {
			await delay(1000);
		}
		// Wait a tiny bit more after applied for state to settle
		await delay(1000);
	};

	return new Promise((resolve, reject) => {
		const timer =
			timeout > 0
				? setTimeout(
						() =>
							reject(
								new Error(
									`Timeout while waiting for the target state to be applied`,
								),
							),
						timeout,
					)
				: undefined;

		waitApplied()
			.then(() => {
				clearTimeout(timer);
				resolve(true);
			})
			.catch(reject);
	});
};

const getStatus = async () =>
	await request(BALENA_SUPERVISOR_ADDRESS)
		.get('/v2/state/status')
		.then(({ body }) => body);

const docker = new Docker();

describe('state engine', () => {
	beforeEach(async () => {
		await setTargetState({
			config: {},
			apps: {},
		});
	});

	after(async () => {
		await setTargetState({
			config: {},
			apps: {},
		});
		await docker.pruneImages({ filters: { dangling: { false: true } } });
	});

	it('installs an app with two services', async () => {
		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadbeef',
					releaseId: 1,
					services: {
						'1': {
							image: 'alpine',
							imageId: 11,
							serviceName: 'one',
							restart: 'unless-stopped',
							running: true,
							command:
								'sh -c "while true; do echo -n \'Hello World!!\' | nc -lv -p 8080; done"',
							stop_signal: 'SIGKILL',
							networks: ['default'],
							ports: ['8080'],
							labels: {},
							environment: {},
						},
						'2': {
							image: 'alpine',
							imageId: 12,
							serviceName: 'two',
							restart: 'unless-stopped',
							running: true,
							command: 'sleep infinity',
							stop_signal: 'SIGKILL',
							networks: ['default'],
							labels: {},
							environment: {},
						},
					},
					networks: {},
					volumes: {},
				},
			},
		});

		const state = await getCurrentState();
		expect(
			state.apps['123'].services.map((s: any) => s.serviceName),
		).to.deep.equal(['one', 'two']);

		const containers = await docker.listContainers();
		expect(
			containers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_11_1_deadbeef', State: 'running' },
			{ Name: '/two_12_1_deadbeef', State: 'running' },
		]);

		// Test that the service is running and accesssible via port 8080
		// this will throw if the server does not respond
		await exec('nc -v docker 8080 -z');
	});

	// This test recovery from issue #1576, where a device running a service from the target release
	// would not stop the service even if there were still network and container changes to be applied
	it('always stops running services depending on a network being changed', async () => {
		// Install part of the target release
		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadca1f',
					releaseId: 2,
					services: {
						'1': {
							image: 'alpine:latest',
							imageId: 21,
							serviceName: 'one',
							restart: 'unless-stopped',
							running: true,
							command: 'sleep infinity',
							stop_signal: 'SIGKILL',
							labels: {},
							environment: {},
						},
					},
					networks: {},
					volumes: {},
				},
			},
		});

		const state = await getCurrentState();
		expect(
			state.apps['123'].services.map((s: any) => s.serviceName),
		).to.deep.equal(['one']);

		const containers = await docker.listContainers();
		expect(
			containers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([{ Name: '/one_21_2_deadca1f', State: 'running' }]);
		const containerIds = containers.map(({ Id }) => Id);

		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadca1f',
					releaseId: 2,
					services: {
						'1': {
							image: 'alpine:latest',
							imageId: 21,
							serviceName: 'one',
							restart: 'unless-stopped',
							running: true,
							command: 'sleep infinity',
							stop_signal: 'SIGKILL',
							networks: ['default'],
							labels: {},
							environment: {},
						},
						'2': {
							image: 'alpine:latest',
							imageId: 22,
							serviceName: 'two',
							restart: 'unless-stopped',
							running: true,
							command: 'sh -c "echo two && sleep infinity"',
							stop_signal: 'SIGKILL',
							networks: ['default'],
							labels: {},
							environment: {},
						},
					},
					networks: {
						default: {
							driver: 'bridge',
							ipam: {
								config: [
									{ gateway: '192.168.91.1', subnet: '192.168.91.0/24' },
								],
								driver: 'default',
							},
						},
					},
					volumes: {},
				},
			},
		});

		const updatedContainers = await docker.listContainers();
		expect(
			updatedContainers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_21_2_deadca1f', State: 'running' },
			{ Name: '/two_22_2_deadca1f', State: 'running' },
		]);

		// Container ids must have changed
		expect(updatedContainers.map(({ Id }) => Id)).to.not.have.members(
			containerIds,
		);

		expect(await docker.getNetwork('123_default').inspect())
			.to.have.property('IPAM')
			.to.deep.equal({
				Config: [{ Gateway: '192.168.91.1', Subnet: '192.168.91.0/24' }],
				Driver: 'default',
				Options: {},
			});
	});

	it('updates an app with two services with a network change where the only change is a custom ipam config addition', async () => {
		const services = {
			'1': {
				image: 'alpine:latest',
				imageId: 11,
				serviceName: 'one',
				restart: 'unless-stopped',
				running: true,
				command: 'sleep infinity',
				stop_signal: 'SIGKILL',
				networks: ['default'],
				labels: {},
				environment: {},
			},
			'2': {
				image: 'alpine:latest',
				imageId: 12,
				serviceName: 'two',
				restart: 'unless-stopped',
				running: true,
				command: 'sleep infinity',
				stop_signal: 'SIGKILL',
				networks: ['default'],
				labels: {},
				environment: {},
			},
		};
		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadbeef',
					releaseId: 1,
					services,
					networks: {
						default: {},
					},
					volumes: {},
				},
			},
		});

		const state = await getCurrentState();
		expect(
			state.apps['123'].services.map((s: any) => s.serviceName),
		).to.deep.equal(['one', 'two']);

		const containers = await docker.listContainers();
		expect(
			containers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_11_1_deadbeef', State: 'running' },
			{ Name: '/two_12_1_deadbeef', State: 'running' },
		]);
		const containerIds = containers.map(({ Id }) => Id);

		// Network should not have custom ipam config
		const defaultNet = await docker.getNetwork('123_default').inspect();
		expect(defaultNet)
			.to.have.property('IPAM')
			.to.not.deep.equal({
				Config: [{ Gateway: '192.168.91.1', Subnet: '192.168.91.0/24' }],
				Driver: 'default',
				Options: {},
			});

		// Network should not have custom ipam label
		expect(defaultNet)
			.to.have.property('Labels')
			.to.not.have.property('io.balena.private.ipam.config');

		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadca1f',
					releaseId: 2,
					services,
					networks: {
						default: {
							driver: 'bridge',
							ipam: {
								config: [
									{ gateway: '192.168.91.1', subnet: '192.168.91.0/24' },
								],
								driver: 'default',
							},
						},
					},
					volumes: {},
				},
			},
		});

		const updatedContainers = await docker.listContainers();
		expect(
			updatedContainers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_11_2_deadca1f', State: 'running' },
			{ Name: '/two_12_2_deadca1f', State: 'running' },
		]);

		// Container ids must have changed
		expect(updatedContainers.map(({ Id }) => Id)).to.not.have.members(
			containerIds,
		);

		// Network should have custom ipam config
		const customNet = await docker.getNetwork('123_default').inspect();
		expect(customNet)
			.to.have.property('IPAM')
			.to.deep.equal({
				Config: [{ Gateway: '192.168.91.1', Subnet: '192.168.91.0/24' }],
				Driver: 'default',
				Options: {},
			});

		// Network should have custom ipam label
		expect(customNet)
			.to.have.property('Labels')
			.to.have.property('io.balena.private.ipam.config');
	});

	it('updates an app with two services with a network change where the only change is a custom ipam config removal', async () => {
		const services = {
			'1': {
				image: 'alpine:latest',
				imageId: 11,
				serviceName: 'one',
				restart: 'unless-stopped',
				running: true,
				command: 'sleep infinity',
				stop_signal: 'SIGKILL',
				networks: ['default'],
				labels: {},
				environment: {},
			},
			'2': {
				image: 'alpine:latest',
				imageId: 12,
				serviceName: 'two',
				restart: 'unless-stopped',
				running: true,
				command: 'sleep infinity',
				stop_signal: 'SIGKILL',
				networks: ['default'],
				labels: {},
				environment: {},
			},
		};
		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadbeef',
					releaseId: 1,
					services,
					networks: {
						default: {
							driver: 'bridge',
							ipam: {
								config: [
									{ gateway: '192.168.91.1', subnet: '192.168.91.0/24' },
								],
								driver: 'default',
							},
						},
					},
					volumes: {},
				},
			},
		});

		const state = await getCurrentState();
		expect(
			state.apps['123'].services.map((s: any) => s.serviceName),
		).to.deep.equal(['one', 'two']);

		// Network should have custom ipam config
		const customNet = await docker.getNetwork('123_default').inspect();
		expect(customNet)
			.to.have.property('IPAM')
			.to.deep.equal({
				Config: [{ Gateway: '192.168.91.1', Subnet: '192.168.91.0/24' }],
				Driver: 'default',
				Options: {},
			});

		// Network should have custom ipam label
		expect(customNet)
			.to.have.property('Labels')
			.to.have.property('io.balena.private.ipam.config');

		const containers = await docker.listContainers();
		expect(
			containers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_11_1_deadbeef', State: 'running' },
			{ Name: '/two_12_1_deadbeef', State: 'running' },
		]);
		const containerIds = containers.map(({ Id }) => Id);

		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadca1f',
					releaseId: 2,
					services,
					networks: {
						default: {},
					},
					volumes: {},
				},
			},
		});

		const updatedContainers = await docker.listContainers();
		expect(
			updatedContainers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_11_2_deadca1f', State: 'running' },
			{ Name: '/two_12_2_deadca1f', State: 'running' },
		]);

		// Container ids must have changed
		expect(updatedContainers.map(({ Id }) => Id)).to.not.have.members(
			containerIds,
		);

		// Network should not have custom ipam config
		const defaultNet = await docker.getNetwork('123_default').inspect();
		expect(defaultNet)
			.to.have.property('IPAM')
			.to.not.deep.equal({
				Config: [{ Gateway: '192.168.91.1', Subnet: '192.168.91.0/24' }],
				Driver: 'default',
				Options: {},
			});

		// Network should not have custom ipam label
		expect(defaultNet)
			.to.have.property('Labels')
			.to.not.have.property('io.balena.private.ipam.config');
	});

	it('updates an app with two services with a network removal', async () => {
		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadbeef',
					releaseId: 1,
					services: {
						'1': {
							image: 'alpine:3.18',
							imageId: 11,
							serviceName: 'one',
							restart: 'unless-stopped',
							running: true,
							command: 'sleep infinity',
							stop_signal: 'SIGKILL',
							labels: {},
							environment: {},
							networks: ['balena'],
						},
						'2': {
							image: 'ubuntu:focal',
							imageId: 12,
							serviceName: 'two',
							restart: 'unless-stopped',
							running: true,
							command: 'sleep infinity',
							labels: {},
							environment: {},
							network_mode: 'host',
						},
					},
					networks: {
						balena: {},
					},
					volumes: {},
				},
			},
		});

		const state = await getCurrentState();
		expect(
			state.apps['123'].services.map((s: any) => s.serviceName),
		).to.deep.equal(['one', 'two']);

		const containers = await docker.listContainers();
		expect(
			containers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_11_1_deadbeef', State: 'running' },
			{ Name: '/two_12_1_deadbeef', State: 'running' },
		]);
		const containerIds = containers.map(({ Id }) => Id);
		await expect(docker.getNetwork('123_balena').inspect()).to.not.be.rejected;

		await setTargetState({
			config: {},
			apps: {
				'123': {
					name: 'test-app',
					commit: 'deadca1f',
					releaseId: 2,
					services: {
						'1': {
							image: 'alpine:latest',
							imageId: 21,
							serviceName: 'one',
							restart: 'unless-stopped',
							running: true,
							command: 'sleep infinity',
							stop_signal: 'SIGKILL',
							networks: ['default'],
							labels: {},
							environment: {},
						},
						'2': {
							image: 'ubuntu:latest',
							imageId: 22,
							serviceName: 'two',
							restart: 'unless-stopped',
							running: true,
							command: 'sh -c "echo two && sleep infinity"',
							stop_signal: 'SIGKILL',
							network_mode: 'host',
							labels: {},
							environment: {},
						},
					},
					networks: {},
					volumes: {},
				},
			},
		});

		const updatedContainers = await docker.listContainers();
		expect(
			updatedContainers.map(({ Names, State }) => ({ Name: Names[0], State })),
		).to.have.deep.members([
			{ Name: '/one_21_2_deadca1f', State: 'running' },
			{ Name: '/two_22_2_deadca1f', State: 'running' },
		]);

		// Container ids must have changed
		expect(updatedContainers.map(({ Id }) => Id)).to.not.have.members(
			containerIds,
		);

		await expect(docker.getNetwork('123_balena').inspect()).to.be.rejected;
	});
});
