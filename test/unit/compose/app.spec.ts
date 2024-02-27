import { expect } from 'chai';
import type { Image } from '~/src/compose/images';
import Network from '~/src/compose/network';
import Volume from '~/src/compose/volume';
import { LocksTakenMap } from '~/lib/update-lock';

import {
	createService,
	createImage,
	createApp,
	DEFAULT_NETWORK,
	expectSteps,
	expectNoStep,
} from '~/test-lib/state-helper';

const defaultContext = {
	keepVolumes: false,
	availableImages: [] as Image[],
	containerIds: {},
	downloading: [] as string[],
	locksTaken: new LocksTakenMap(),
};

describe('compose/app', () => {
	describe('volume state behavior', () => {
		it('should correctly infer a volume create step', () => {
			// Setup current and target apps
			const current = createApp();
			const target = createApp({
				volumes: [Volume.fromComposeObject('test-volume', 1, 'deadbeef')],
				isTarget: true,
			});

			// Calculate the steps
			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// Check that a createVolume step has been created
			const [createVolumeStep] = expectSteps('createVolume', steps);
			expect(createVolumeStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'test-volume' });
		});

		it('should correctly infer more than one volume create step', () => {
			const current = createApp();
			const target = createApp({
				volumes: [
					Volume.fromComposeObject('test-volume', 1, 'deadbeef'),
					Volume.fromComposeObject('test-volume-2', 1, 'deadbeef'),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// Check that 2 createVolume steps are found
			const createVolumeSteps = expectSteps('createVolume', steps, 2);

			// Check that the steps contain the volumes without any order
			// expectation
			expect(
				createVolumeSteps.filter(
					(step: any) => step.target && step.target.name === 'test-volume',
				),
			).to.have.lengthOf(1);

			expect(
				createVolumeSteps.filter(
					(step: any) => step.target && step.target.name === 'test-volume-2',
				),
			).to.have.lengthOf(1);
		});

		// We don't remove volumes until the end
		it('should not infer a volume remove step when the app is still referenced', () => {
			const current = createApp({
				volumes: [
					Volume.fromComposeObject('test-volume', 1, 'deadbeef'),
					Volume.fromComposeObject('test-volume-2', 1, 'deadbeef'),
				],
			});
			const target = createApp({
				volumes: [Volume.fromComposeObject('test-volume-2', 1, 'deadbeef')],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectNoStep('removeVolume', steps);
		});

		it('should correctly infer volume recreation steps', () => {
			const current = createApp({
				volumes: [Volume.fromComposeObject('test-volume', 1, 'deadbeef')],
			});
			const target = createApp({
				volumes: [
					Volume.fromComposeObject('test-volume', 1, 'deadbeef', {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			// First step should create a volume removal step
			const stepsForRemoval = current.nextStepsForAppUpdate(
				defaultContext,
				target,
			);

			const [removalStep] = expectSteps('removeVolume', stepsForRemoval);
			expect(removalStep)
				.to.have.property('current')
				.that.has.property('name')
				.that.equals('test-volume');
			expect(removalStep)
				.to.have.property('current')
				.that.has.property('appId')
				.that.equals(1);

			// we are assuming that after the execution steps the current state of the
			// app will look like this
			const intermediate = createApp({
				volumes: [],
			});

			// This test is extra since we have already tested that the volume gets created
			const stepsForCreation = intermediate.nextStepsForAppUpdate(
				defaultContext,
				target,
			);
			const [creationStep] = expectSteps('createVolume', stepsForCreation);

			expect(creationStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({
					labels: {
						'io.balena.supervised': 'true',
						'io.balena.app-uuid': 'deadbeef',
						test: 'test',
					},
				});
		});

		it('should kill dependencies of a volume before changing config', async () => {
			const current = createApp({
				services: [
					await createService({
						serviceName: 'test',
						composition: { volumes: ['test-volume:/data'] },
					}),
				],
				volumes: [Volume.fromComposeObject('test-volume', 1, 'deadbeef')],
			});
			const target = createApp({
				services: [
					await createService({
						serviceName: 'test',
						composition: { volumes: ['test-volume:/data'] },
					}),
				],
				volumes: [
					Volume.fromComposeObject('test-volume', 1, 'deadbeef', {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			// Calculate steps
			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });
		});

		it('should correctly infer to remove an app volumes when the app is being removed', () => {
			const current = createApp({
				volumes: [Volume.fromComposeObject('test-volume', 1, 'deadbeef')],
			});

			const steps = current.stepsToRemoveApp(defaultContext);
			const [removeVolumeStep] = expectSteps('removeVolume', steps);

			expect(removeVolumeStep).to.have.property('current').that.deep.includes({
				name: 'test-volume',
			});
		});

		it('should not output a kill step for a service which is already stopping when changing a volume', async () => {
			const service = await createService({
				serviceName: 'test',
				composition: { volumes: ['test-volume:/data'] },
			});
			service.status = 'Stopping';
			const current = createApp({
				services: [service],
				volumes: [Volume.fromComposeObject('test-volume', 1, 'deadbeef')],
			});
			const target = createApp({
				services: [service],
				volumes: [
					Volume.fromComposeObject('test-volume', 1, 'deadbeef', {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectNoStep('kill', steps);
		});

		it('should generate the correct step sequence for a volume purge request', async () => {
			const service = await createService({
				appId: 1,
				appUuid: 'deadbeef',
				image: 'test-image',
				composition: { volumes: ['db-volume:/data'] },
			});
			const volume = Volume.fromComposeObject('db-volume', 1, 'deadbeef');
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						createImage({
							appId: service.appId,
							name: 'test-image',
						}),
					],
				},
			};

			// Temporarily set target services & volumes to empty, as in doPurge
			const intermediateTarget = createApp({
				services: [],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			// Generate initial state with one service & one volume
			const current = createApp({
				services: [service],
				networks: [DEFAULT_NETWORK],
				volumes: [volume],
			});

			// Step 1: kill
			const steps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			expectSteps('kill', steps);

			// Step 2: noop (service is stopping)
			service.status = 'Stopping';
			const secondStageSteps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			expectSteps('noop', secondStageSteps);
			expect(secondStageSteps).to.have.length(1);

			// No steps, simulate container removal & explicit volume removal as in doPurge
			const currentWithServiceRemoved = createApp({
				services: [],
				networks: [DEFAULT_NETWORK],
				volumes: [volume],
			});
			expect(
				currentWithServiceRemoved.nextStepsForAppUpdate(
					contextWithImages,
					intermediateTarget,
				),
			).to.have.length(0);

			// Simulate volume removal
			const currentWithVolumesRemoved = createApp({
				services: [],
				networks: [DEFAULT_NETWORK],
				volumes: [],
			});

			// Step 3: createVolume
			service.status = 'Running';
			const target = createApp({
				services: [service],
				networks: [DEFAULT_NETWORK],
				volumes: [volume],
				isTarget: true,
			});
			const recreateVolumeSteps =
				currentWithVolumesRemoved.nextStepsForAppUpdate(
					contextWithImages,
					target,
				);

			expect(recreateVolumeSteps).to.have.length(1);
			expectSteps('createVolume', recreateVolumeSteps);

			// Final step: start service
			const currentWithVolumeRecreated = createApp({
				services: [],
				networks: [DEFAULT_NETWORK],
				volumes: [volume],
			});

			const createServiceSteps =
				currentWithVolumeRecreated.nextStepsForAppUpdate(
					contextWithImages,
					target,
				);
			expectSteps('start', createServiceSteps);
		});
	});

	describe('network state behavior', () => {
		it('should correctly infer a network create step', () => {
			const current = createApp({ networks: [] });
			const target = createApp({
				networks: [Network.fromComposeObject('default', 1, 'deadbeef', {})],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep).to.have.property('target').that.deep.includes({
				name: 'default',
			});
		});

		it('should correctly infer a network remove step', () => {
			const current = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
			});
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [removeNetworkStep] = expectSteps('removeNetwork', steps);

			expect(removeNetworkStep).to.have.property('current').that.deep.includes({
				name: 'test-network',
			});
		});

		it('should correctly remove default duplicate networks', () => {
			const current = createApp({
				networks: [DEFAULT_NETWORK, DEFAULT_NETWORK],
			});
			const target = createApp({
				networks: [],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [removeNetworkStep] = expectSteps('removeNetwork', steps);

			expect(removeNetworkStep).to.have.property('current').that.deep.includes({
				name: 'default',
			});
		});

		it('should correctly remove duplicate networks', () => {
			const current = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
			});
			const target = createApp({
				networks: [
					// The target is a single network
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [removeNetworkStep] = expectSteps('removeNetwork', steps);

			expect(removeNetworkStep).to.have.property('current').that.deep.includes({
				name: 'test-network',
			});
		});

		it('should ignore the duplicates if there are changes already', () => {
			const current = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
			});
			const target = createApp({
				networks: [
					// The target is a single network
					Network.fromComposeObject('test-network', 1, 'deadbeef', {
						config_only: true,
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [removeNetworkStep] = expectSteps('removeNetwork', steps);

			expect(removeNetworkStep).to.have.property('current').that.deep.includes({
				name: 'test-network',
			});
		});

		// This should never happen because there can never be a service that is refencing
		// a network that has a duplicate
		it('should generate service kill steps if there are duplicate networks', async () => {
			const current = createApp({
				appUuid: 'deadbeef',
				networks: [
					DEFAULT_NETWORK,
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
				services: [
					await createService({
						appId: 1,
						appUuid: 'deadbeef',
						serviceName: 'test',
						composition: { networks: ['test-network'] },
					}),
				],
			});
			const target = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
				services: [
					await createService({
						appId: 1,
						appUuid: 'deadbeef',
						serviceName: 'test',
						composition: { networks: ['test-network'] },
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [removeNetworkStep] = expectSteps('kill', steps);

			expect(removeNetworkStep).to.have.property('current').that.deep.includes({
				serviceName: 'test',
			});
		});

		it('should correctly infer more than one network removal step', () => {
			const current = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
					Network.fromComposeObject('test-network-2', 1, 'deadbeef', {}),
				],
				isTarget: true,
			});
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [first, second] = expectSteps('removeNetwork', steps, 2);

			expect(first).to.have.property('current').that.deep.includes({
				name: 'test-network',
			});
			expect(second).to.have.property('current').that.deep.includes({
				name: 'test-network-2',
			});
		});

		it('should correctly infer a network recreation step', () => {
			const current = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
			});
			const target = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {
						labels: { TEST: 'TEST' },
					}),
				],
				isTarget: true,
			});

			const stepsForRemoval = current.nextStepsForAppUpdate(
				defaultContext,
				target,
			);

			const [removeStep] = expectSteps('removeNetwork', stepsForRemoval);
			expect(removeStep)
				.to.have.property('current')
				.that.deep.includes({ name: 'test-network' });

			// We assume that the intermediate state looks like this
			const intermediate = createApp({
				networks: [],
			});

			const stepsForCreation = intermediate.nextStepsForAppUpdate(
				defaultContext,
				target,
			);

			const [createNetworkStep] = expectSteps(
				'createNetwork',
				stepsForCreation,
				1,
				2, // The update will also generate a step for the default network but we don't care about that
			);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'test-network' });

			expect(createNetworkStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({
					labels: { TEST: 'TEST', 'io.balena.app-id': '1' },
				});
		});

		it('should kill dependencies of networks before removing', async () => {
			const current = createApp({
				appUuid: 'deadbeef',
				services: [
					await createService({
						appId: 1,
						appUuid: 'deadbeef',
						serviceName: 'test',
						composition: { networks: ['test-network'] },
					}),
				],
				networks: [
					Network.fromComposeObject('test-network', 1, 'deadbeef', {}),
				],
			});
			const target = createApp({
				appUuid: 'deadbeef',
				services: [
					await createService({ appUuid: 'deadbeef', serviceName: 'test' }),
				],
				networks: [],
				isTarget: true,
			});

			const availableImages = [createImage({ appUuid: 'deadbeef' })];

			const steps = current.nextStepsForAppUpdate(
				{ ...defaultContext, availableImages },
				target,
			);
			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });
		});

		it('should kill dependencies of networks before changing config', async () => {
			const current = createApp({
				services: [
					await createService({
						serviceName: 'test',
						composition: { networks: ['test-network'] },
					}),
				],
				networks: [Network.fromComposeObject('test-network', 1, 'appuuid', {})],
			});
			const target = createApp({
				services: [
					await createService({
						serviceName: 'test',
						composition: { networks: { 'test-network': {} } },
					}),
				],
				networks: [
					Network.fromComposeObject('test-network', 1, 'appuuid', {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [killStep] = expectSteps('kill', steps);

			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });

			// We shouldn't try to remove the network until we have gotten rid of the dependencies
			expectNoStep('removeNetwork', steps);
		});

		it('should always kill dependencies of networks before removing', async () => {
			const current = createApp({
				services: [
					// The device for some reason is already running some services
					// of the new release, but we need to kill it anyways
					await createService({
						image: 'alpine',
						serviceName: 'one',
						commit: 'deadca1f',
						composition: { command: 'sleep infinity', networks: ['default'] },
					}),
				],
				networks: [Network.fromComposeObject('default', 1, 'appuuid', {})],
			});
			const target = createApp({
				services: [
					await createService({
						image: 'alpine',
						serviceName: 'one',
						commit: 'deadca1f',
						composition: { command: 'sleep infinity', networks: ['default'] },
					}),
					await createService({
						image: 'alpine',
						serviceName: 'two',
						commit: 'deadca1f',
						composition: {
							command: 'sh -c "echo two && sleep infinity"',
							networks: ['default'],
						},
					}),
				],
				networks: [
					Network.fromComposeObject('default', 1, 'appuuid', {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			const availableImages = [
				createImage({ appId: 1, serviceName: 'one', name: 'alpine' }),
				createImage({ appId: 1, serviceName: 'two', name: 'alpine' }),
			];

			const steps = current.nextStepsForAppUpdate(
				{ ...defaultContext, availableImages },
				target,
			);
			const [killStep] = expectSteps('kill', steps);

			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'one' });

			// We shouldn't try to remove the network until we have gotten rid of the dependencies
			expectNoStep('removeNetwork', steps);
		});

		it('should kill dependencies of networks before updating between releases', async () => {
			const current = createApp({
				services: [
					await createService({
						image: 'alpine',
						serviceName: 'one',
						commit: 'deadbeef',
						composition: { command: 'sleep infinity', networks: ['default'] },
					}),
					await createService({
						image: 'alpine',
						serviceName: 'two',
						commit: 'deadbeef',
						composition: { command: 'sleep infinity', networks: ['default'] },
					}),
				],
				networks: [Network.fromComposeObject('default', 1, 'appuuid', {})],
			});
			const target = createApp({
				services: [
					await createService({
						image: 'alpine',
						serviceName: 'one',
						commit: 'deadca1f',
						composition: { command: 'sleep infinity', networks: ['default'] },
					}),
					await createService({
						image: 'alpine',
						serviceName: 'two',
						commit: 'deadca1f',
						composition: {
							command: 'sh -c "echo two && sleep infinity"',
							networks: ['default'],
						},
					}),
				],
				networks: [
					Network.fromComposeObject('default', 1, 'appuuid', {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			const availableImages = [
				createImage({ appId: 1, serviceName: 'one', name: 'alpine' }),
				createImage({ appId: 1, serviceName: 'two', name: 'alpine' }),
			];

			const steps = current.nextStepsForAppUpdate(
				{ ...defaultContext, availableImages },
				target,
			);
			expectSteps('kill', steps, 2);

			expect(steps.map((s) => (s as any).current.serviceName)).to.have.members([
				'one',
				'two',
			]);

			// We shouldn't try to remove the network until we have gotten rid of the dependencies
			expectNoStep('removeNetwork', steps);
		});

		it('should create the default network if it does not exist', () => {
			const current = createApp({ networks: [] });
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// A default network should always be created
			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'default' });
		});

		it('should not create the default network if it already exists', () => {
			const current = createApp({
				networks: [Network.fromComposeObject('default', 1, 'deadbeef', {})],
			});
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// The network should not be created again
			expectNoStep('createNetwork', steps);
		});

		it('should create a config-only network if network_mode is host for all services', async () => {
			const svcOne = await createService({
				appId: 1,
				serviceName: 'one',
				composition: { network_mode: 'host' },
			});
			const svcTwo = await createService({
				appId: 1,
				serviceName: 'two',
				composition: { network_mode: 'host' },
			});
			const current = createApp({
				services: [svcOne, svcTwo],
				networks: [],
			});
			const target = createApp({
				services: [svcOne, svcTwo],
				networks: [],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({ configOnly: true });
		});

		it('should not create a config-only network if network_mode: host is not specified for any service', async () => {
			const svcOne = await createService({
				appId: 1,
				serviceName: 'one',
				composition: { network_mode: 'host' },
			});
			const svcTwo = await createService({
				appId: 1,
				serviceName: 'two',
			});
			const current = createApp({
				services: [svcOne, svcTwo],
				networks: [],
			});
			const target = createApp({
				services: [svcOne, svcTwo],
				networks: [],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({ configOnly: false });
		});

		it('should create a config-only network if there are no services in the app', () => {
			const current = createApp({});
			const target = createApp({ isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({ configOnly: true });
		});
	});

	describe('service state behavior', () => {
		it('should create a kill step for a service which is no longer referenced', async () => {
			const current = createApp({
				services: [
					await createService({ appId: 1, serviceName: 'main' }),
					await createService({ appId: 1, serviceName: 'aux' }),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [await createService({ appId: 1, serviceName: 'main' })],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				{
					...defaultContext,
					// With default download-then-kill, a kill should be inferred
					// once all images in target state are available
					availableImages: [createImage({ serviceName: 'main' })],
				},
				target,
			);
			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'aux' });
		});

		it('should emit a noop when a service which is no longer referenced is already stopping', async () => {
			const current = createApp({
				services: [
					await createService(
						{ serviceName: 'main' },
						{ state: { status: 'Stopping' } },
					),
				],
			});
			const target = createApp({ services: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectSteps('noop', steps);

			// Kill was already emitted for this service
			expectNoStep('kill', steps);
		});

		it('should emit a noop while waiting on a stopping service', async () => {
			const current = createApp({
				services: [
					await createService(
						{ serviceName: 'main', running: true },
						{ state: { status: 'Stopping' } },
					),
				],
			});
			const target = createApp({
				services: [await createService({ serviceName: 'main', running: true })],
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectSteps('noop', steps);
		});

		it('should remove a dead container that is still referenced in the target state', async () => {
			const current = createApp({
				services: [
					await createService(
						{ serviceName: 'main' },
						{ state: { status: 'Dead' } },
					),
				],
			});
			const target = createApp({
				services: [await createService({ serviceName: 'main' })],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [removeStep] = expectSteps('remove', steps);

			expect(removeStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main' });
		});

		it('should remove a dead container that is not referenced in the target state', async () => {
			const current = createApp({
				services: [
					await createService(
						{ serviceName: 'main' },
						{ state: { status: 'Dead' } },
					),
				],
			});
			const target = createApp({ services: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [removeStep] = expectSteps('remove', steps);

			expect(removeStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main' });
		});

		it('should emit a noop when a service has an image downloading', async () => {
			const current = createApp({ services: [] });
			const target = createApp({
				services: [
					await createService({ image: 'main-image', serviceName: 'main' }),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				{ ...defaultContext, ...{ downloading: ['main-image'] } },
				target,
			);
			expectSteps('noop', steps);
			expectNoStep('fetch', steps);
		});

		it('should emit a takeLock followed by an updateMetadata step when a service has not changed but the release has', async () => {
			const current = createApp({
				services: [
					await createService({
						serviceName: 'main',
						appId: 1,
						commit: 'old-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						serviceName: 'main',
						appId: 1,
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			// Take lock before updating metadata
			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [takeLockStep] = expectSteps('takeLock', steps);
			expect(takeLockStep).to.have.property('appId').that.equals(1);
			expect(takeLockStep)
				.to.have.property('services')
				.that.deep.equals(['main']);

			// Infer updateMetadata after locks are taken
			const steps2 = current.nextStepsForAppUpdate(
				{
					...defaultContext,
					locksTaken: new LocksTakenMap([{ appId: 1, services: ['main'] }]),
				},
				target,
			);
			const [updateMetadataStep] = expectSteps('updateMetadata', steps2);
			expect(updateMetadataStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main', commit: 'old-release' });
			expect(updateMetadataStep)
				.to.have.property('target')
				.to.deep.include({ serviceName: 'main', commit: 'new-release' });
		});

		it('should stop a container which has `running: false` as its target', async () => {
			const current = createApp({
				services: [await createService({ serviceName: 'main' })],
			});
			const target = createApp({
				services: [
					await createService({ running: false, serviceName: 'main' }),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [stopStep] = expectSteps('stop', steps);
			expect(stopStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main' });
		});

		it('should not try to start a container which has exited and has restart policy of no', async () => {
			// Container is a "run once" type of service so it has exitted.
			const current = createApp({
				services: [
					await createService(
						{ composition: { restart: 'no' }, running: false },
						{ state: { containerId: 'run_once' } },
					),
				],
			});

			// Now test that another start step is not added on this service
			const target = createApp({
				services: [
					await createService(
						{ composition: { restart: 'no' }, running: false },
						{ state: { containerId: 'run_once' } },
					),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectNoStep('start', steps);
		});

		it('should recreate a container if the target configuration changes', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						createImage({ appId: 1, serviceName: 'main', name: 'main-image' }),
					],
				},
			};

			const current = createApp({
				services: [await createService({ appId: 1, serviceName: 'main' })],
				// Default network was already created
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						appId: 1,
						serviceName: 'main',
						composition: { privileged: true },
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			// should see a 'stop'
			const stepsToIntermediate = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);
			const [killStep] = expectSteps('kill', stepsToIntermediate);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });

			// assume the intermediate step has already removed the app
			const intermediate = createApp({
				services: [],
				// Default network was already created
				networks: [DEFAULT_NETWORK],
			});

			// now should see a 'start'
			const stepsToTarget = intermediate.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [startStep] = expectSteps('start', stepsToTarget);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'main' });
			expect(startStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({ privileged: true });
		});

		it('should not start a container when it depends on a service which is being installed', async () => {
			const availableImages = [
				createImage({ appId: 1, serviceName: 'main', name: 'main-image' }),
				createImage({ appId: 1, serviceName: 'dep', name: 'dep-image' }),
			];
			const contextWithImages = { ...defaultContext, ...{ availableImages } };

			const current = createApp({
				services: [
					await createService(
						{
							running: false,
							appId: 1,
							serviceName: 'dep',
						},
						{
							state: {
								status: 'Installing',
								containerId: 'dep-id',
							},
						},
					),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						appId: 1,
						serviceName: 'main',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						appId: 1,
						serviceName: 'dep',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const stepsToIntermediate = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			// Only one start step and it should be that of the 'dep' service
			const [startStep] = expectSteps('start', stepsToIntermediate);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'dep' });

			// we now make our current state have the 'dep' service as started...
			const intermediate = createApp({
				services: [
					await createService(
						{ appId: 1, serviceName: 'dep' },
						{ state: { containerId: 'dep-id' } },
					),
				],
				networks: [DEFAULT_NETWORK],
			});

			// we should now see a start for the 'main' service...
			const stepsToTarget = intermediate.nextStepsForAppUpdate(
				{ ...contextWithImages, ...{ containerIds: { dep: 'dep-id' } } },
				target,
			);

			const [startMainStep] = expectSteps('start', stepsToTarget);
			expect(startMainStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'main' });
		});

		it('should not create a start step when all that changes is a running state', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						createImage({ appId: 1, name: 'main-image', serviceName: 'main' }),
					],
				},
			};
			const current = createApp({
				services: [
					await createService({ running: false, serviceName: 'main' }),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [await createService({ serviceName: 'main' })],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(contextWithImages, target);

			// There should be no steps since the engine manages restart policy for stopped containers
			expect(steps.length).to.equal(0);
		});

		it('should create a kill step when a service release has to be updated but the strategy is kill-then-download', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						createImage({ appId: 1, name: 'main-image', serviceName: 'main' }),
					],
				},
			};

			const labels = {
				'io.balena.update.strategy': 'kill-then-download',
			};

			const current = createApp({
				services: [
					await createService({
						labels,
						image: 'main-image',
						serviceName: 'main',
						commit: 'old-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						labels,
						image: 'main-image-2',
						serviceName: 'main',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const stepsToIntermediate = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [killStep] = expectSteps('kill', stepsToIntermediate);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });

			// assume steps were applied
			const intermediate = createApp({
				services: [],
				networks: [DEFAULT_NETWORK],
			});

			const stepsToTarget = intermediate.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [fetchStep] = expectSteps('fetch', stepsToTarget);
			expect(fetchStep)
				.to.have.property('image')
				.that.deep.includes({ name: 'main-image-2' });
		});

		it('should not infer a kill step with the default strategy if a dependency is not downloaded', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					downloading: ['dep-image-2'], // The depended service image is being downloaded
					availableImages: [
						createImage({ appId: 1, name: 'main-image', serviceName: 'main' }),
						createImage({ appId: 1, name: 'dep-image', serviceName: 'dep' }),
						createImage({
							appId: 1,
							name: 'main-image-2',
							serviceName: 'main',
						}),
					],
				},
			};

			const current = createApp({
				services: [
					await createService({
						image: 'main-image',
						appId: 1,
						serviceName: 'main',
						commit: 'old-release',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						image: 'dep-image',
						appId: 1,
						serviceName: 'dep',
						commit: 'old-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						image: 'main-image-2',
						appId: 1,
						serviceName: 'main',
						commit: 'new-release',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						image: 'dep-image-2',
						appId: 1,
						serviceName: 'dep',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			// No kill steps should be generated
			const steps = current.nextStepsForAppUpdate(contextWithImages, target);
			expectNoStep('kill', steps);
		});

		it('should create several kill steps as long as there are unmet dependencies', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						createImage({ appId: 1, name: 'main-image', serviceName: 'main' }),
						createImage({
							appId: 1,
							name: 'main-image-2',
							serviceName: 'main',
						}),
					],
				},
			};

			const current = createApp({
				services: [
					await createService({
						image: 'main-image',
						serviceName: 'main',
						commit: 'old-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						image: 'main-image-2',
						// new release as target
						serviceName: 'main',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const stepsFirstTry = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [killStep] = expectSteps('kill', stepsFirstTry);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });

			// if at first you don't succeed
			const stepsSecondTry = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			// Since current state has not changed, another kill step needs to be generated
			const [newKillStep] = expectSteps('kill', stepsSecondTry);
			expect(newKillStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });
		});

		it('should create a kill step when a service config has to be updated but the strategy is kill-then-download', async () => {
			const labels = {
				'io.balena.update.strategy': 'kill-then-download',
			};

			const current = createApp({
				services: [await createService({ serviceName: 'test', labels })],
			});
			const target = createApp({
				services: [
					await createService({
						serviceName: 'test',
						labels,
						composition: {
							privileged: true,
						},
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });
		});

		it('should not start a service when a network it depends on is not ready', async () => {
			const current = createApp({ networks: [DEFAULT_NETWORK] });
			const target = createApp({
				services: [
					await createService({
						composition: { networks: ['test'] },
						appId: 1,
					}),
				],
				networks: [
					DEFAULT_NETWORK,
					Network.fromComposeObject('test', 1, 'appuuid', {}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'test' });

			// service should not be created yet
			expectNoStep('start', steps);
		});

		it('should create several kill steps as long as there are no unmet dependencies', async () => {
			const current = createApp({
				services: [
					await createService({
						appId: 1,
						serviceName: 'one',
						commit: 'old-release',
					}),
					await createService({
						appId: 1,
						serviceName: 'two',
						commit: 'old-release',
					}),
					await createService({
						appId: 1,
						serviceName: 'three',
						commit: 'old-release',
					}),
				],
			});
			const target = createApp({
				services: [
					await createService({
						appId: 1,
						serviceName: 'three',
						commit: 'new-release',
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				{
					...defaultContext,
					// With default download-then-kill strategy, target images
					// should all be available before a kill step is inferred
					availableImages: [createImage({ serviceName: 'three' })],
				},
				target,
			);
			expectSteps('kill', steps, 2);
		});

		it('should not infer a kill step with the default strategy before all target images have been downloaded', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					downloading: ['other-image-2'], // One of the images is being downloaded
					availableImages: [
						createImage({ appId: 1, name: 'main-image', serviceName: 'main' }),
						createImage({
							appId: 1,
							name: 'other-image',
							serviceName: 'other',
						}),
						createImage({
							appId: 1,
							name: 'main-image-2',
							serviceName: 'main',
						}),
					],
				},
			};

			const current = createApp({
				services: [
					await createService({
						image: 'main-image',
						appId: 1,
						serviceName: 'main',
						commit: 'old-release',
					}),
					await createService({
						image: 'other-image',
						appId: 1,
						serviceName: 'other',
						commit: 'old-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						image: 'main-image-2',
						appId: 1,
						serviceName: 'main',
						commit: 'new-release',
					}),
					await createService({
						image: 'other-image-2',
						appId: 1,
						serviceName: 'other',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			// No kill steps should be generated
			const steps = current.nextStepsForAppUpdate(contextWithImages, target);
			expectNoStep('kill', steps);
		});

		it('should not infer a start step before all target images have been downloaded', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					downloading: ['other-image'], // One of the images is being downloaded
					availableImages: [
						createImage({ appId: 1, name: 'main-image', serviceName: 'main' }),
					],
				},
			};

			const current = createApp({
				services: [],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						image: 'main-image',
						appId: 1,
						serviceName: 'main',
						commit: 'new-release',
					}),
					await createService({
						image: 'other-image',
						appId: 1,
						serviceName: 'other',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			// No kill steps should be generated
			const steps = current.nextStepsForAppUpdate(contextWithImages, target);
			expectNoStep('start', steps);
		});

		it('should infer a start step only when target images have been downloaded', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					downloading: [], // One of the images is being downloaded
					availableImages: [
						createImage({ appId: 1, name: 'main-image', serviceName: 'main' }),
						createImage({
							appId: 1,
							name: 'other-image',
							serviceName: 'other',
						}),
					],
				},
			};

			const current = createApp({
				services: [],
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services: [
					await createService({
						image: 'main-image',
						appId: 1,
						serviceName: 'main',
						commit: 'new-release',
					}),
					await createService({
						image: 'other-image',
						appId: 1,
						serviceName: 'other',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			// No kill steps should be generated
			const steps = current.nextStepsForAppUpdate(contextWithImages, target);
			expectSteps('start', steps, 2);
		});
	});

	describe('image state behavior', () => {
		it('should emit a fetch step when an image has not been downloaded for a service', async () => {
			const current = createApp({ services: [] });
			const target = createApp({
				services: [await createService({ serviceName: 'main' })],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [fetchStep] = expectSteps('fetch', steps);
			expect(fetchStep)
				.to.have.property('image')
				.that.deep.includes({ serviceName: 'main' });
		});

		it('should not infer a fetch step when the download is already in progress', async () => {
			const contextWithDownloading = {
				...defaultContext,
				...{
					downloading: ['image2'],
				},
			};
			const current = createApp({ services: [] });
			const target = createApp({
				services: [
					await createService({ image: 'image2', serviceName: 'main' }),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				contextWithDownloading,
				target,
			);
			expectNoStep('fetch', steps);
		});

		it('should not infer a kill step with the default strategy if a dependency is not downloaded', async () => {
			const current = createApp({
				services: [await createService({ image: 'image1' })],
			});
			const target = createApp({
				services: [await createService({ image: 'image2' })],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [fetchStep] = expectSteps('fetch', steps);
			expect(fetchStep)
				.to.have.property('image')
				.that.deep.includes({ name: 'image2' });

			expectNoStep('kill', steps);
		});
	});

	describe('update lock state behavior', () => {
		it('should infer a releaseLock step if there are locks to be released before settling target state', async () => {
			const services = [
				await createService({ serviceName: 'server' }),
				await createService({ serviceName: 'client' }),
			];
			const current = createApp({
				services,
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services,
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				{
					...defaultContext,
					locksTaken: new LocksTakenMap([
						{ appId: 1, services: ['server', 'client'] },
					]),
				},
				target,
			);
			const [releaseLockStep] = expectSteps('releaseLock', steps, 1);
			expect(releaseLockStep).to.have.property('appId').that.equals(1);

			// Even if not all the locks are taken, releaseLock should be inferred
			const steps2 = current.nextStepsForAppUpdate(
				{
					...defaultContext,
					locksTaken: new LocksTakenMap([{ appId: 1, services: ['server'] }]),
				},
				target,
			);
			const [releaseLockStep2] = expectSteps('releaseLock', steps2, 1);
			expect(releaseLockStep2).to.have.property('appId').that.equals(1);
		});

		it('should not infer a releaseLock step if there are no locks to be released', async () => {
			const services = [
				await createService({ serviceName: 'server' }),
				await createService({ serviceName: 'client' }),
			];
			const current = createApp({
				services,
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services,
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expect(steps).to.have.length(0);
		});

		it('should infer a releaseLock step for the current appId only', async () => {
			const services = [
				await createService({ serviceName: 'server' }),
				await createService({ serviceName: 'client' }),
			];
			const current = createApp({
				services,
				networks: [DEFAULT_NETWORK],
			});
			const target = createApp({
				services,
				networks: [DEFAULT_NETWORK],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				{
					...defaultContext,
					locksTaken: new LocksTakenMap([
						{ appId: 1, services: ['server', 'client'] },
						{ appId: 2, services: ['main'] },
					]),
				},
				target,
			);
			const [releaseLockStep] = expectSteps('releaseLock', steps, 1);
			expect(releaseLockStep).to.have.property('appId').that.equals(1);
		});
	});
});
