import { expect } from 'chai';
import * as sinon from 'sinon';
import Docker from 'dockerode';
import * as applicationManager from '~/src/compose/application-manager';
import * as imageManager from '~/src/compose/images';
import * as serviceManager from '~/src/compose/service-manager';
import Network from '~/src/compose/network';
import * as networkManager from '~/src/compose/network-manager';
import Volume from '~/src/compose/volume';
import * as config from '~/src/config';
import { LocksTakenMap } from '~/lib/update-lock';
import { createDockerImage } from '~/test-lib/docker-helper';
import {
	createService,
	createImage,
	createApps,
	createCurrentState,
	DEFAULT_NETWORK,
	expectSteps,
	expectNoStep,
} from '~/test-lib/state-helper';
import type { InstancedAppState } from '~/src/types';

// TODO: application manager inferNextSteps still queries some stuff from
// the engine instead of receiving that information as parameter. Refactoring
// the method to be more of a pure function would allow us to move a lot of these tests
// to unit tests, leaving the need of integration tests just for more complex stuff that
// the application-manager also does and that is not currently tested.
// TODO: also, there is some redundancy between what is tested here and what is tested in
// the app spec, remove that redundancy to simplify the tests
describe('compose/application-manager', () => {
	before(async () => {
		// Service.fromComposeObject gets api keys from the database
		// which also depend on the local mode. This ensures the database
		// is initialized. This can be removed when ApplicationManager and Service
		// a refactored to work as pure functions
		await config.initialized();
	});

	beforeEach(async () => {
		// Set up network by default
		await networkManager.ensureSupervisorNetwork();
	});

	afterEach(async () => {
		// Delete any created networks
		const docker = new Docker();
		const allNetworks = await docker.listNetworks();
		await Promise.all(
			allNetworks
				// exclude docker default networks from the cleanup
				.filter(({ Name }) => !['bridge', 'host', 'none'].includes(Name))
				.map(({ Name }) => docker.getNetwork(Name).remove()),
		);
	});

	// TODO: we don't test application manager initialization as it sets up a bunch of timers
	// and listeners that may affect other tests. This is a bad pattern and it needs to be purged
	// from the codebase
	it.skip('should init', async () => {
		await applicationManager.initialized();
	});

	// TODO: missing tests for getCurrentApps

	it('should not infer a start step when all that changes is a running state', async () => {
		const targetApps = createApps(
			{
				services: [await createService({ running: true, appId: 1 })],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [await createService({ running: false, appId: 1 })],
				networks: [DEFAULT_NETWORK],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// There should be no steps since the engine manages restart policy for stopped containers
		expect(steps.length).to.equal(0);
	});

	it('infers a kill step when a service has to be removed', async () => {
		const targetApps = createApps(
			{
				services: [],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [await createService()],
				networks: [DEFAULT_NETWORK],
			});

		const [killStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(killStep).to.have.property('action').that.equals('kill');
		expect(killStep)
			.to.have.property('current')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('infers a fetch step when a service has to be updated', async () => {
		const targetApps = createApps(
			{
				services: [await createService({ image: 'image-new', appId: 1 })],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [await createService({ appId: 1 })],
				networks: [DEFAULT_NETWORK],
				images: [],
			});

		const [fetchStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(fetchStep).to.have.property('action').that.equals('fetch');
		expect(fetchStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'image-new' });
	});

	it('does not infer a fetch step when the download is already in progress', async () => {
		const targetApps = createApps(
			{
				services: [await createService({ image: 'image-new', appId: 1 })],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [await createService({ appId: 1 })],
				networks: [DEFAULT_NETWORK],
				downloading: ['image-new'],
			});

		const [noopStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(noopStep).to.have.property('action').that.equals('noop');
		expect(nextSteps).to.have.lengthOf(0);
	});

	it('infers a kill step when a service has to be updated but the strategy is kill-then-download', async () => {
		const labels = {
			'io.balena.update.strategy': 'kill-then-download',
		};
		const targetApps = createApps(
			{
				services: [
					await createService({
						image: 'image-new',
						labels,
						appId: 1,
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService(
						{
							image: 'image-old',
							labels,
							appId: 1,
							commit: 'old-release',
						},
						{ options: { imageInfo: { Id: 'sha256:image-old-id' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
			});

		const [killStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(killStep).to.have.property('action').that.equals('kill');
		expect(killStep)
			.to.have.property('current')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('infers a kill step when a service has to be updated but the strategy is delete-then-download', async () => {
		const labels = {
			'io.balena.update.strategy': 'delete-then-download',
		};
		const targetApps = createApps(
			{
				services: [
					await createService({
						image: 'image-new',
						labels,
						appId: 1,
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService(
						{
							image: 'image-old',
							labels,
							appId: 1,
							commit: 'old-release',
						},
						{ options: { imageInfo: { Id: 'sha256:image-old-id' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
			});

		const [killStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(killStep).to.have.property('action').that.equals('kill');
		expect(killStep)
			.to.have.property('current')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('infers a remove step when the current service has stopped and the strategy is delete-then-download', async () => {
		const labels = {
			'io.balena.update.strategy': 'delete-then-download',
		};
		const targetApps = createApps(
			{
				services: [
					await createService({
						image: 'image-new',
						labels,
						appId: 1,
						serviceName: 'main',
						commit: 'new-release',
					}),
				],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				images: [
					createImage({
						appId: 1,
						name: 'image-old',
						serviceName: 'main',
						dockerImageId: 'image-old-id',
					}),
				],
				networks: [DEFAULT_NETWORK],
			});

		const [removeImage] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// First we should see a kill
		expect(removeImage).to.have.property('action').that.equals('removeImage');
		expect(removeImage)
			.to.have.property('image')
			.that.deep.includes({ name: 'image-old' });
	});

	// These cases test whether the Supervisor handles multi-container updates
	// on a per-app basis rather than a per-service while also respecting update strategies.
	describe('update strategy compliance for multi-container apps', () => {
		const createCurrentAndTargetServicesWithLabels = async (labels: {
			[key: string]: string;
		}) => {
			const currentServices = [
				await createService({
					image: 'image-main',
					labels,
					appId: 1,
					serviceName: 'main',
					commit: 'old-release',
					releaseId: 1,
				}),
				await createService({
					image: 'image-old',
					labels,
					appId: 1,
					serviceName: 'old',
					commit: 'old-release',
					releaseId: 1,
				}),
			];
			const targetServices = [
				await createService({
					image: 'image-main',
					labels,
					appId: 1,
					serviceName: 'main',
					commit: 'new-release',
					releaseId: 2,
				}),
				await createService({
					image: 'image-new',
					labels,
					appId: 1,
					serviceName: 'new',
					commit: 'new-release',
					releaseId: 2,
				}),
			];
			return { currentServices, targetServices };
		};

		it('should not infer a kill step for current service A before target service B download finishes with download-then-kill', async () => {
			const labels = {
				'io.balena.update.strategy': 'download-then-kill',
			};
			const { currentServices, targetServices } =
				await createCurrentAndTargetServicesWithLabels(labels);

			/**
			 * Before target image finishes downloading, do not infer kill step
			 */
			let targetApps = createApps(
				{
					services: targetServices,
				},
				true,
			);
			const c1 = createCurrentState({
				services: currentServices,
				networks: [DEFAULT_NETWORK],
				downloading: ['image-new'],
			});
			const steps = await applicationManager.inferNextSteps(
				c1.currentApps,
				targetApps,
				{
					downloading: c1.downloading,
					availableImages: c1.availableImages,
					containerIdsByAppId: c1.containerIdsByAppId,
				},
			);
			// There should be two noop steps, one for target service which is still downloading,
			// and one for current service which is waiting on target download to complete.
			expectSteps('noop', steps, 2);
			// No kill step yet
			expectNoStep('kill', steps);

			/**
			 * After target image finishes downloading, infer a kill step
			 */
			targetApps = createApps(
				{
					services: targetServices,
				},
				true,
			);
			const { currentApps, availableImages, downloading, containerIdsByAppId } =
				createCurrentState({
					services: currentServices,
					networks: [DEFAULT_NETWORK],
					images: [
						// Both images have been downloaded or had their metadata updated
						createImage({
							name: 'image-main',
							appId: 1,
							serviceName: 'main',
							commit: 'new-release',
							releaseId: 2,
						}),
						createImage({
							name: 'image-new',
							appId: 1,
							serviceName: 'new',
							commit: 'new-release',
							releaseId: 2,
						}),
					],
				});
			const steps2 = await applicationManager.inferNextSteps(
				currentApps,
				targetApps,
				{
					downloading,
					availableImages,
					containerIdsByAppId,
				},
			);
			// Service `old` is safe to kill after download for `new` has completed
			const [killStep] = expectSteps('kill', steps2, 1);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'old' });
			// Service `new` in target release should be started as download has completed
			const [startStep] = expectSteps('start', steps2, 1);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'new' });
			// No noop steps
			expectNoStep('noop', steps2);
		});

		it('should infer a fetch step for target service B together with current service A kill with kill-then-download', async () => {
			const labels = {
				'io.balena.update.strategy': 'kill-then-download',
			};
			const { currentServices, targetServices } =
				await createCurrentAndTargetServicesWithLabels(labels);
			const targetApps = createApps(
				{
					services: targetServices,
				},
				true,
			);

			/**
			 * Infer fetch step for new target service together with kill & updateMetadata steps for current services
			 */
			const c1 = createCurrentState({
				services: currentServices,
				networks: [DEFAULT_NETWORK],
			});
			const steps = await applicationManager.inferNextSteps(
				c1.currentApps,
				targetApps,
				{
					downloading: c1.downloading,
					// Simulate old images already removed from image table
					// to avoid removeImage steps
					availableImages: [],
					containerIdsByAppId: c1.containerIdsByAppId,
					// Mock locks for service to be updated via updateMetadata
					// to avoid takeLock step
					locksTaken: new LocksTakenMap([{ appId: 1, services: ['main'] }]),
				},
			);
			// Service `new` should be fetched
			const [fetchStep] = expectSteps('fetch', steps, 1);
			expect(fetchStep).to.have.property('serviceName').that.equals('new');
			// Service `old` should be killed
			const [killStep] = expectSteps('kill', steps, 1);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'old' });
			// Service `main` should have its metadata updated
			const [updateMetadataStep] = expectSteps('updateMetadata', steps, 1);
			expect(updateMetadataStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'main' });

			/**
			 * Noop while target image is downloading
			 */
			const c2 = createCurrentState({
				// Simulate `kill` and `updateMetadata` steps already executed
				services: currentServices
					.filter(({ serviceName }) => serviceName !== 'old')
					.map((svc) => {
						svc.releaseId = 2;
						svc.commit = 'new-release';
						return svc;
					}),
				networks: [DEFAULT_NETWORK],
			});
			const steps2 = await applicationManager.inferNextSteps(
				c2.currentApps,
				targetApps,
				{
					downloading: ['image-new'],
					availableImages: c2.availableImages,
					containerIdsByAppId: c2.containerIdsByAppId,
				},
			);
			// Noop while service `new` is downloading
			expectSteps('noop', steps2, 1);
			// No start step should be generated until fetch completes
			expectNoStep('start', steps2);
			// No other steps
			expect(steps2).to.have.length(1);

			/**
			 * Infer start step only after download completes
			 */
			const steps3 = await applicationManager.inferNextSteps(
				c2.currentApps,
				targetApps,
				{
					downloading: c1.downloading,
					// Both images have been downloaded or had their metadata updated
					availableImages: [
						createImage({
							name: 'image-main',
							appId: 1,
							serviceName: 'main',
							commit: 'new-release',
							releaseId: 2,
						}),
						createImage({
							name: 'image-new',
							appId: 1,
							serviceName: 'new',
							commit: 'new-release',
							releaseId: 2,
						}),
					],
					containerIdsByAppId: c1.containerIdsByAppId,
				},
			);
			// Service `new` should be started
			const [startStep] = expectSteps('start', steps3, 1);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'new' });
			// No other steps
			expect(steps3).to.have.length(1);
		});

		it('should infer a fetch step for target service B together with current service A removal with delete-then-download', async () => {
			const labels = {
				'io.balena.update.strategy': 'delete-then-download',
			};
			const { currentServices, targetServices } =
				await createCurrentAndTargetServicesWithLabels(labels);
			const targetApps = createApps(
				{
					services: targetServices,
				},
				true,
			);

			/**
			 * Infer fetch step for new target service together with kill & updateMetadata steps for current services
			 */
			const c1 = createCurrentState({
				services: currentServices,
				networks: [DEFAULT_NETWORK],
			});
			const steps = await applicationManager.inferNextSteps(
				c1.currentApps,
				targetApps,
				{
					downloading: c1.downloading,
					// Simulate old images already removed from image table
					// to avoid removeImage steps
					availableImages: [],
					containerIdsByAppId: c1.containerIdsByAppId,
					// Mock locks for service to be updated via updateMetadata
					// to avoid takeLock step
					locksTaken: new LocksTakenMap([{ appId: 1, services: ['main'] }]),
				},
			);
			// Service `new` should be fetched
			const [fetchStep] = expectSteps('fetch', steps, 1);
			expect(fetchStep).to.have.property('serviceName').that.equals('new');
			// Service `old` should be killed
			const [killStep] = expectSteps('kill', steps, 1);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'old' });
			// Service `main` should have its metadata updated
			const [updateMetadataStep] = expectSteps('updateMetadata', steps, 1);
			expect(updateMetadataStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'main' });

			/**
			 * Noop while target image is downloading
			 */
			const c2 = createCurrentState({
				// Simulate `kill` and `updateMetadata` steps already executed
				services: currentServices
					.filter(({ serviceName }) => serviceName !== 'old')
					.map((svc) => {
						svc.releaseId = 2;
						svc.commit = 'new-release';
						return svc;
					}),
				networks: [DEFAULT_NETWORK],
			});
			const steps2 = await applicationManager.inferNextSteps(
				c2.currentApps,
				targetApps,
				{
					downloading: ['image-new'],
					availableImages: c2.availableImages,
					containerIdsByAppId: c2.containerIdsByAppId,
				},
			);
			// Noop while service `new` is downloading
			expectSteps('noop', steps2, 1);
			// No start step should be generated until fetch completes
			expectNoStep('start', steps2);
			// No other steps
			expect(steps2).to.have.length(1);

			/**
			 * Infer start step only after download completes
			 */
			const steps3 = await applicationManager.inferNextSteps(
				c2.currentApps,
				targetApps,
				{
					downloading: c1.downloading,
					// Both images have been downloaded or had their metadata updated
					availableImages: [
						createImage({
							name: 'image-main',
							appId: 1,
							serviceName: 'main',
							commit: 'new-release',
							releaseId: 2,
						}),
						createImage({
							name: 'image-new',
							appId: 1,
							serviceName: 'new',
							commit: 'new-release',
							releaseId: 2,
						}),
					],
					containerIdsByAppId: c1.containerIdsByAppId,
				},
			);
			// Service `new` should be started
			const [startStep] = expectSteps('start', steps3, 1);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'new' });
			// No other steps
			expect(steps3).to.have.length(1);
		});

		it('should not start target services until all downloads have completed with kill|delete-then-download', async () => {
			const targetServices = [
				await createService({
					serviceName: 'one',
					image: 'image-one',
					labels: {
						'io.balena.update.strategy': 'kill-then-download',
					},
				}),
				await createService({
					serviceName: 'two',
					image: 'image-two',
					labels: {
						'io.balena.update.strategy': 'delete-then-download',
					},
				}),
			];
			const targetApps = createApps(
				{
					services: targetServices,
				},
				true,
			);
			const { currentApps, availableImages, containerIdsByAppId } =
				createCurrentState({
					services: [],
					networks: [DEFAULT_NETWORK],
				});

			/**
			 * Noop while both images are still downloading
			 */
			const steps = await applicationManager.inferNextSteps(
				currentApps,
				targetApps,
				{
					downloading: ['image-one', 'image-two'],
					availableImages,
					containerIdsByAppId,
				},
			);
			expectSteps('noop', steps, 2);
			// No other steps
			expect(steps).to.have.length(2);

			/**
			 * Noop while one image is still downloading
			 */
			const steps2 = await applicationManager.inferNextSteps(
				currentApps,
				targetApps,
				{
					downloading: ['image-two'],
					availableImages: [
						createImage({
							name: 'image-one',
							serviceName: 'one',
						}),
					],
					containerIdsByAppId,
				},
			);
			expectSteps('noop', steps2, 1);
			// No other steps
			expect(steps2).to.have.length(1);

			/**
			 * Only start target services after both images downloaded
			 */
			const steps3 = await applicationManager.inferNextSteps(
				currentApps,
				targetApps,
				{
					downloading: [],
					availableImages: [
						createImage({
							name: 'image-one',
							serviceName: 'one',
						}),
						createImage({
							name: 'image-two',
							serviceName: 'two',
						}),
					],
					containerIdsByAppId,
				},
			);
			expectSteps('start', steps3, 2);
			// No other steps
			expect(steps3).to.have.length(2);
		});
	});

	it('does not infer to kill a service with default strategy if a dependency is not downloaded', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService({
						image: 'main-image',
						appId: 1,
						commit: 'new-release',
						serviceName: 'main',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						image: 'dep-image',
						appId: 1,
						commit: 'new-release',
						serviceName: 'dep',
					}),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService({
						appId: 1,
						commit: 'old-release',
						serviceName: 'main',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						appId: 1,
						commit: 'old-release',
						serviceName: 'dep',
					}),
				],
				networks: [DEFAULT_NETWORK],
				downloading: ['dep-image'], // dep-image is still being downloaded
				images: [
					// main-image was already downloaded
					createImage({
						appId: 1,
						name: 'main-image',
						serviceName: 'main',
					}),
				],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Only noop steps should be seen at this point
		expect(steps.filter((s) => s.action !== 'noop')).to.have.lengthOf(0);
	});

	it('infers to kill several services as long as there is no unmet dependency', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService({
						image: 'main-image',
						appId: 1,
						appUuid: 'appuuid',
						commit: 'new-release',
						serviceName: 'main',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						image: 'dep-image',
						appId: 1,
						appUuid: 'appuuid',
						commit: 'new-release',
						serviceName: 'dep',
					}),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);

		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService({
						appId: 1,
						appUuid: 'appuuid',
						commit: 'old-release',
						serviceName: 'main',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						appId: 1,
						appUuid: 'appuuid',
						commit: 'old-release',
						serviceName: 'dep',
					}),
				],
				networks: [DEFAULT_NETWORK],
				images: [
					// Both images have been downloaded
					createImage({
						appId: 1,
						appUuid: 'appuuid',
						name: 'main-image',
						serviceName: 'main',
						commit: 'new-release',
					}),
					createImage({
						appId: 1,
						appUuid: 'appuuid',
						name: 'dep-image',
						serviceName: 'dep',
						commit: 'new-release',
					}),
				],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// We should see kill steps for both currently running services
		expect(
			steps.filter(
				(s: any) => s.action === 'kill' && s.current.serviceName === 'dep',
			),
		).to.have.lengthOf(1);
		expect(
			steps.filter(
				(s: any) => s.action === 'kill' && s.current.serviceName === 'main',
			),
		).to.have.lengthOf(1);
	});

	it('infers to start the dependency first', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService({
						image: 'main-image',
						serviceName: 'main',
						commit: 'new-release',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						image: 'dep-image',
						serviceName: 'dep',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);

		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [DEFAULT_NETWORK],
				images: [
					// Both images have been downloaded
					createImage({
						name: 'main-image',
						serviceName: 'main',
						commit: 'new-release',
					}),
					createImage({
						name: 'dep-image',
						serviceName: 'dep',
						commit: 'new-release',
					}),
				],
			});

		const [startStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step should happen for the depended service first
		expect(startStep).to.have.property('action').that.equals('start');
		expect(startStep)
			.to.have.property('target')
			.that.deep.includes({ serviceName: 'dep' });

		// No more steps until the first container has been started
		expect(nextSteps).to.have.lengthOf(0);
	});

	it('infers to start a service once its dependency has been met', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService({
						image: 'main-image',
						serviceName: 'main',
						commit: 'new-release',
						composition: {
							depends_on: ['dep'],
						},
					}),
					await createService({
						image: 'dep-image',
						serviceName: 'dep',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);

		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService({
						image: 'dep-image',
						serviceName: 'dep',
						commit: 'new-release',
					}),
				],
				networks: [DEFAULT_NETWORK],
				images: [
					// Both images have been downloaded
					createImage({
						name: 'main-image',
						serviceName: 'main',
						commit: 'new-release',
					}),
					createImage({
						name: 'dep-image',
						serviceName: 'dep',
						commit: 'new-release',
					}),
				],
			});

		const [startStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(startStep).to.have.property('action').that.equals('start');
		expect(startStep)
			.to.have.property('target')
			.that.deep.includes({ serviceName: 'main' });

		expect(nextSteps).to.have.lengthOf(0);
	});

	it('infers to remove spurious containers', async () => {
		const targetApps = createApps(
			{
				services: [await createService({ image: 'main-image' })],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService({ appId: 5, serviceName: 'old-service' }),
				],
				networks: [DEFAULT_NETWORK],
				images: [
					// Image has been downloaded
					createImage({
						name: 'main-image',
						serviceName: 'main',
					}),
				],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Start the new service
		expect(
			steps.filter(
				(s: any) => s.action === 'start' && s.target.serviceName === 'main',
			),
		).to.have.lengthOf(1);

		// Remove the leftover service
		expect(
			steps.filter(
				(s: any) =>
					s.action === 'kill' && s.current.serviceName === 'old-service',
			),
		).to.have.lengthOf(1);
	});

	it('should not remove an app volumes when they are no longer referenced', async () => {
		const targetApps = createApps({ networks: [DEFAULT_NETWORK] }, true);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [DEFAULT_NETWORK],
				volumes: [Volume.fromComposeObject('test-volume', 1, 'deadbeef')],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(steps.filter((s) => s.action === 'removeVolume')).to.be.empty;
	});

	it('should remove volumes from previous applications', async () => {
		const targetApps = createApps({ networks: [DEFAULT_NETWORK] }, true);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [],
				// Volume with different id
				volumes: [Volume.fromComposeObject('test-volume', 2, 'deadbeef')],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(steps.filter((s) => s.action === 'removeVolume')).to.not.be.empty;
	});

	it('should remove volumes from previous applications except if keepVolumes is set', async () => {
		const targetApps = createApps({ networks: [DEFAULT_NETWORK] }, true);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [],
				// Volume with different id
				volumes: [Volume.fromComposeObject('test-volume', 2, 'deadbeef')],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				keepVolumes: true,
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(steps.filter((s) => s.action === 'removeVolume')).to.be.empty;
	});

	it('should infer that we need to create the supervisor network if it does not exist', async () => {
		const docker = new Docker();
		await docker.getNetwork('supervisor0').remove();

		const targetApps = createApps(
			{ services: [await createService()], networks: [DEFAULT_NETWORK] },
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [DEFAULT_NETWORK],
			});

		const [ensureNetworkStep, ...nextSteps] =
			await applicationManager.inferNextSteps(currentApps, targetApps, {
				downloading,
				availableImages,
				containerIdsByAppId,
			});
		expect(ensureNetworkStep).to.deep.include({
			action: 'ensureSupervisorNetwork',
		});
		expect(nextSteps).to.have.lengthOf(0);
	});

	it('should kill a service which depends on the supervisor network, if we need to create the network', async () => {
		const docker = new Docker();
		await docker.getNetwork('supervisor0').remove();

		const labels = { 'io.balena.features.supervisor-api': 'true' };

		const targetApps = createApps(
			{
				services: [
					await createService({ labels }, { options: { listenPort: '48484' } }),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService({ labels }, { options: { listenPort: '48484' } }),
				],
				networks: [DEFAULT_NETWORK],
			});

		const [killStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(killStep).to.have.property('action').that.equals('kill');
		expect(killStep)
			.to.have.property('current')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('should infer a cleanup step when a cleanup is required', async () => {
		// Create a dangling image; this is done by building an image again with
		// some slightly different metadata, leaving the old image with no metadata.
		const docker = new Docker();
		const dockerImageIdOne = await createDockerImage(
			'some-image:some-tag',
			['io.balena.testing=1'],
			docker,
		);
		const dockerImageIdTwo = await createDockerImage(
			'some-image:some-tag',
			['io.balena.testing=2'],
			docker,
		);
		// Remove the tagged image, leaving only the dangling image
		await docker.getImage(dockerImageIdTwo).remove();

		const targetApps = createApps(
			{
				services: [await createService()],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [await createService()],
				networks: [DEFAULT_NETWORK],
			});

		const [cleanupStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Cleanup needs to happen first
		expect(cleanupStep).to.deep.include({
			action: 'cleanup',
		});
		expect(nextSteps).to.have.lengthOf(0);

		await docker.getImage(dockerImageIdOne).remove();
	});

	it('should infer that an image should be removed if it is no longer referenced in current or target state (only target)', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image' },
						// Target has a matching image already
						{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [DEFAULT_NETWORK],
				images: [
					// An image for a service that no longer exists
					createImage({
						name: 'old-image',
						appId: 5,
						serviceName: 'old-service',
						dockerImageId: 'sha256:aaaa',
					}),
					createImage({
						name: 'main-image',
						appId: 1,
						serviceName: 'main',
						dockerImageId: 'sha256:bbbb',
					}),
				],
			});

		const [removeImageStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(removeImageStep)
			.to.have.property('action')
			.that.equals('removeImage');
		expect(removeImageStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'old-image' });
	});

	it('should infer that an image should be removed if it is no longer referenced in current or target state (only target) unless keepImages is true', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image' },
						// Target has a matching image already
						{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [DEFAULT_NETWORK],
				images: [
					// An image for a service that no longer exists
					createImage({
						name: 'old-image',
						appId: 5,
						serviceName: 'old-service',
						dockerImageId: 'sha256:aaaa',
					}),
					createImage({
						name: 'main-image',
						appId: 1,
						serviceName: 'main',
						dockerImageId: 'sha256:bbbb',
					}),
				],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				keepImages: true,
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);
		expect(steps.filter((s) => s.action === 'removeImage')).to.be.empty;
	});

	it('should infer that an image should be removed if it is no longer referenced in current or target state (only current)', async () => {
		const targetApps = createApps(
			{
				services: [],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService(
						{ image: 'main-image' },
						// Target has a matching image already
						{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
				images: [
					// An image for a service that no longer exists
					createImage({
						name: 'old-image',
						appId: 5,
						serviceName: 'old-service',
						dockerImageId: 'sha256:aaaa',
					}),
					createImage({
						name: 'main-image',
						appId: 1,
						serviceName: 'main',
						dockerImageId: 'sha256:bbbb',
					}),
				],
			});

		const [removeImageStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(removeImageStep)
			.to.have.property('action')
			.that.equals('removeImage');
		expect(removeImageStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'old-image' });
	});

	it('should infer that an image should be removed if it is no longer referenced in current or target state (only current) unless keepImages is true', async () => {
		const targetApps = createApps(
			{
				services: [],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [
					await createService(
						{ image: 'main-image' },
						// Target has a matching image already
						{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
				images: [
					// An image for a service that no longer exists
					createImage({
						name: 'old-image',
						appId: 5,
						serviceName: 'old-service',
						dockerImageId: 'sha256:aaaa',
					}),
					createImage({
						name: 'main-image',
						appId: 1,
						serviceName: 'main',
						dockerImageId: 'sha256:bbbb',
					}),
				],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				keepImages: true,
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);
		expect(steps.filter((s) => s.action === 'removeImage')).to.be.empty;
	});

	it('should infer that an image should be saved if it is not in the available image list but it can be found on disk', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image' },
						// Target has image info
						{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [DEFAULT_NETWORK],
				images: [], // no available images exist
			});

		const [saveImageStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(saveImageStep).to.have.property('action').that.equals('saveImage');
		expect(saveImageStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'main-image' });
	});

	it('should correctly generate steps for multiple apps', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService({
						running: true,
						image: 'main-image-1',
						appId: 1,
						appUuid: 'app-one',
						commit: 'commit-for-app-1',
					}),
					await createService({
						running: true,
						image: 'main-image-2',
						appId: 2,
						appUuid: 'app-two',
						commit: 'commit-for-app-2',
					}),
				],
				networks: [
					// Default networks for two apps
					Network.fromComposeObject('default', 1, 'app-one', {}),
					Network.fromComposeObject('default', 2, 'app-two', {}),
				],
			},
			true,
		);
		const { currentApps, availableImages, downloading, containerIdsByAppId } =
			createCurrentState({
				services: [],
				networks: [
					// Default networks for two apps
					Network.fromComposeObject('default', 1, 'app-one', {}),
					Network.fromComposeObject('default', 2, 'app-two', {}),
				],
				images: [
					createImage({
						name: 'main-image-1',
						appId: 1,
						appUuid: 'app-one',
						serviceName: 'main',
						commit: 'commit-for-app-1',
					}),
					createImage({
						name: 'main-image-2',
						appId: 2,
						appUuid: 'app-two',
						serviceName: 'main',
						commit: 'commit-for-app-2',
					}),
				],
			});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Expect a start step for both apps
		expect(
			steps.filter(
				(s: any) =>
					s.action === 'start' &&
					s.target.appId === 1 &&
					s.target.serviceName === 'main',
			),
		).to.have.lengthOf(1);
		expect(
			steps.filter(
				(s: any) =>
					s.action === 'start' &&
					s.target.appId === 2 &&
					s.target.serviceName === 'main',
			),
		).to.have.lengthOf(1);
	});

	describe("getting application's current state", () => {
		let getImagesState: sinon.SinonStub;
		let getServicesState: sinon.SinonStub;

		before(() => {
			getImagesState = sinon.stub(imageManager, 'getState');
			getServicesState = sinon.stub(serviceManager, 'getState');
		});

		afterEach(() => {
			getImagesState.reset();
			getServicesState.reset();
		});

		after(() => {
			getImagesState.restore();
			getServicesState.restore();
		});

		it('reports the state of images if no service is available', async () => {
			getImagesState.resolves([
				{
					name: 'ubuntu:latest',
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'ubuntu',
					status: 'Downloaded',
				},
				{
					name: 'alpine:latest',
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'alpine',
					status: 'Downloading',
					downloadProgress: 50,
				},
				{
					name: 'fedora:latest',
					commit: 'newrelease',
					appUuid: 'fedora',
					serviceName: 'fedora',
					status: 'Downloading',
					downloadProgress: 75,
				},
				{
					name: 'fedora:older',
					commit: 'oldrelease',
					appUuid: 'fedora',
					serviceName: 'fedora',
					status: 'Downloaded',
				},
			]);
			getServicesState.resolves([]);

			expect(await applicationManager.getState()).to.deep.equal({
				myapp: {
					releases: {
						latestrelease: {
							services: {
								ubuntu: {
									image: 'ubuntu:latest',
									status: 'Downloaded',
								},
								alpine: {
									image: 'alpine:latest',
									status: 'Downloading',
									download_progress: 50,
								},
							},
						},
					},
				},
				fedora: {
					releases: {
						oldrelease: {
							services: {
								fedora: {
									image: 'fedora:older',
									status: 'Downloaded',
								},
							},
						},
						newrelease: {
							services: {
								fedora: {
									image: 'fedora:latest',
									status: 'Downloading',
									download_progress: 75,
								},
							},
						},
					},
				},
			});
		});

		it('augments the service data with image data', async () => {
			getImagesState.resolves([
				{
					name: 'ubuntu:latest',
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'ubuntu',
					status: 'Downloaded',
				},
				{
					name: 'node:latest',
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'node',
					status: 'Downloading',
					downloadProgress: 0,
				},
				{
					name: 'alpine:latest',
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'alpine',
					status: 'Downloading',
					downloadProgress: 50,
				},
				{
					name: 'fedora:older',
					commit: 'oldrelease',
					appUuid: 'fedora',
					serviceName: 'fedora',
					status: 'Downloaded',
				},
			]);
			getServicesState.resolves([
				{
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'ubuntu',
					status: 'Running',
					createdAt: new Date('2021-09-01T13:00:00'),
				},
				{
					commit: 'oldrelease',
					serviceName: 'fedora',
					status: 'exited',
					createdAt: new Date('2021-09-01T12:00:00'),
				},
				{
					// Service without an image should not show on the final state
					appUuid: 'debian',
					commit: 'otherrelease',
					serviceName: 'debian',
					status: 'exited',
					createdAt: new Date('2021-09-01T12:00:00'),
				},
			]);

			expect(await applicationManager.getState()).to.deep.equal({
				myapp: {
					releases: {
						latestrelease: {
							services: {
								ubuntu: {
									image: 'ubuntu:latest',
									status: 'Running',
								},
								alpine: {
									image: 'alpine:latest',
									status: 'Downloading',
									download_progress: 50,
								},
								node: {
									image: 'node:latest',
									status: 'Downloading',
									download_progress: 0,
								},
							},
						},
					},
				},
				fedora: {
					releases: {
						oldrelease: {
							services: {
								fedora: {
									image: 'fedora:older',
									status: 'exited',
								},
							},
						},
					},
				},
			});
		});

		it('reports handover state if multiple services are running for the same app', async () => {
			getImagesState.resolves([
				{
					name: 'alpine:3.13',
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'alpine',
					status: 'Downloaded',
				},
				{
					name: 'alpine:3.12',
					commit: 'oldrelease',
					appUuid: 'myapp',
					serviceName: 'alpine',
					status: 'Downloaded',
				},
			]);
			getServicesState.resolves([
				{
					commit: 'latestrelease',
					appUuid: 'myapp',
					serviceName: 'alpine',
					status: 'Running',
					createdAt: new Date('2021-09-01T13:00:00'),
				},
				{
					commit: 'oldrelease',
					appUuid: 'myapp',
					serviceName: 'alpine',
					status: 'Running',
					createdAt: new Date('2021-09-01T12:00:00'),
				},
			]);

			expect(await applicationManager.getState()).to.deep.equal({
				myapp: {
					releases: {
						latestrelease: {
							services: {
								alpine: {
									image: 'alpine:3.13',
									status: 'Awaiting handover',
								},
							},
						},
						oldrelease: {
							services: {
								alpine: {
									image: 'alpine:3.12',
									status: 'Handing over',
								},
							},
						},
					},
				},
			});
		});
	});

	// In the case where a container requires a host resource such as a network interface that is not created by the time the Engine
	// comes up, the Engine will not attempt to restart the container which seems to be Docker's implemented behavior (if not the correct behavior).
	// An example of a host resource would be a port binding such as 192.168.88.1:3000:3000, where the IP is an interface delayed in creation by host.
	// In this case, the Supervisor parses the exit message of the container, and if it matches the error regex, start the container.
	describe('handling Engine restart policy inaction when host resource required by container is delayed in creation', () => {
		const getCurrentState = async (withHostError: boolean) => {
			const exitErrorMessage = withHostError
				? 'driver failed programming external connectivity on endpoint one_1_1_deadbeef (deadca1f): Error starting userland proxy: listen tcp4 192.168.88.1:8081: bind: cannot assign requested address'
				: 'My test error';
			return createCurrentState({
				services: [
					await createService(
						{
							image: 'test-image',
							serviceName: 'one',
							running: false,
							composition: {
								restart: 'always',
							},
						},
						{
							state: {
								status: 'exited',
								exitErrorMessage,
							},
						},
					),
					await createService(
						{
							image: 'test-image',
							serviceName: 'two',
							running: false,
							composition: {
								restart: 'unless-stopped',
							},
						},
						{
							state: {
								status: 'exited',
								exitErrorMessage,
							},
						},
					),
					await createService(
						{
							image: 'test-image',
							serviceName: 'three',
							running: false,
							composition: {
								restart: 'on-failure',
							},
						},
						{
							state: {
								status: 'exited',
								exitErrorMessage,
							},
						},
					),
					await createService(
						{
							image: 'test-image',
							serviceName: 'four',
							running: false,
							composition: {
								restart: 'no',
							},
						},
						{
							state: {
								status: 'exited',
								exitErrorMessage,
							},
						},
					),
				],
				networks: [DEFAULT_NETWORK],
				images: [
					createImage({
						name: 'test-image',
						serviceName: 'one',
					}),
					createImage({
						name: 'test-image',
						serviceName: 'two',
					}),
					createImage({
						name: 'test-image',
						serviceName: 'three',
					}),
					createImage({
						name: 'test-image',
						serviceName: 'four',
					}),
				],
			});
		};

		let targetApps: InstancedAppState;

		before(async () => {
			targetApps = createApps(
				{
					services: [
						await createService({
							image: 'test-image',
							serviceName: 'one',
							running: true,
							composition: {
								restart: 'always',
							},
						}),
						await createService({
							image: 'test-image',
							serviceName: 'two',
							running: true,
							composition: {
								restart: 'unless-stopped',
							},
						}),
						await createService({
							image: 'test-image',
							serviceName: 'three',
							running: true,
							composition: {
								restart: 'on-failure',
							},
						}),
						await createService({
							image: 'test-image',
							serviceName: 'four',
							running: true,
							composition: {
								restart: 'no',
							},
						}),
					],
					networks: [DEFAULT_NETWORK],
				},
				true,
			);
		});

		it('should infer a start step for a service that exited with the "userland proxy" error for all restart policies', async () => {
			const { currentApps, availableImages, downloading, containerIdsByAppId } =
				await getCurrentState(true);

			const [startStep1, startStep2, startStep3, startStep4, ...nextSteps] =
				await applicationManager.inferNextSteps(currentApps, targetApps, {
					downloading,
					availableImages,
					containerIdsByAppId,
				});

			[startStep1, startStep2, startStep3, startStep4].forEach((step) => {
				expect(step).to.have.property('action').that.equals('start');
				expect(step)
					.to.have.property('target')
					.that.has.property('serviceName')
					.that.is.oneOf(['one', 'two', 'three', 'four']);
			});
			expect(nextSteps).to.have.lengthOf(0);
		});

		it('should not infer any steps for a service with a status of "exited" without the "userland proxy" error message', async () => {
			const { currentApps, availableImages, downloading, containerIdsByAppId } =
				await getCurrentState(false);

			const [...steps] = await applicationManager.inferNextSteps(
				currentApps,
				targetApps,
				{
					downloading,
					availableImages,
					containerIdsByAppId,
				},
			);

			expect(steps).to.have.lengthOf(0);
		});
	});
});
