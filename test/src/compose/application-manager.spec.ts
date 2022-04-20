import { expect } from 'chai';
import * as sinon from 'sinon';
import { stub } from 'sinon';
import App from '../../../src/compose/app';
import * as applicationManager from '../../../src/compose/application-manager';
import * as imageManager from '../../../src/compose/images';
import * as serviceManager from '../../../src/compose/service-manager';
import { Image } from '../../../src/compose/images';
import Network from '../../../src/compose/network';
import * as networkManager from '../../../src/compose/network-manager';
import Service from '../../../src/compose/service';
import { ServiceComposeConfig } from '../../../src/compose/types/service';
import Volume from '../../../src/compose/volume';
import log from '../../../src/lib/supervisor-console';
import { InstancedAppState } from '../../../src/types/state';

import * as dbHelper from '../../lib/db-helper';
import * as fsUtils from '../../../src/lib/fs-utils';

const DEFAULT_NETWORK = Network.fromComposeObject('default', 1, 'appuuid', {});

async function createService(
	{
		appId = 1,
		appUuid = 'appuuid',
		serviceName = 'main',
		commit = 'main-commit',
		...conf
	} = {} as Partial<ServiceComposeConfig>,
	{ state = {} as Partial<Service>, options = {} as any } = {},
) {
	const svc = await Service.fromComposeObject(
		{
			appId,
			appUuid,
			serviceName,
			commit,
			// db ids should not be used for target state calculation, but images
			// are compared using _.isEqual so leaving this here to have image comparisons
			// match
			serviceId: 1,
			imageId: 1,
			releaseId: 1,
			...conf,
		},
		options,
	);

	// Add additonal configuration
	for (const k of Object.keys(state)) {
		(svc as any)[k] = (state as any)[k];
	}
	return svc;
}

function createImage(
	{
		appId = 1,
		appUuid = 'appuuid',
		name = 'test-image',
		serviceName = 'main',
		commit = 'main-commit',
		...extra
	} = {} as Partial<Image>,
) {
	return {
		appId,
		appUuid,
		name,
		serviceName,
		commit,
		// db ids should not be used for target state calculation, but images
		// are compared using _.isEqual so leaving this here to have image comparisons
		// match
		imageId: 1,
		releaseId: 1,
		serviceId: 1,
		dependent: 0,
		...extra,
	} as Image;
}

function createApps(
	{
		services = [] as Service[],
		networks = [] as Network[],
		volumes = [] as Volume[],
	},
	target = false,
) {
	const servicesByAppId = services.reduce(
		(svcs, s) => ({ ...svcs, [s.appId]: [s].concat(svcs[s.appId] || []) }),
		{} as Dictionary<Service[]>,
	);
	const volumesByAppId = volumes.reduce(
		(vols, v) => ({ ...vols, [v.appId]: [v].concat(vols[v.appId] || []) }),
		{} as Dictionary<Volume[]>,
	);
	const networksByAppId = networks.reduce(
		(nets, n) => ({ ...nets, [n.appId]: [n].concat(nets[n.appId] || []) }),
		{} as Dictionary<Network[]>,
	);

	const allAppIds = [
		...new Set([
			...Object.keys(servicesByAppId),
			...Object.keys(networksByAppId),
			...Object.keys(volumesByAppId),
		]),
	].map((i) => parseInt(i, 10));

	const apps: InstancedAppState = {};
	for (const appId of allAppIds) {
		apps[appId] = new App(
			{
				appId,
				services: servicesByAppId[appId] ?? [],
				networks: (networksByAppId[appId] ?? []).reduce(
					(nets, n) => ({ ...nets, [n.name]: n }),
					{},
				),
				volumes: (volumesByAppId[appId] ?? []).reduce(
					(vols, v) => ({ ...vols, [v.name]: v }),
					{},
				),
			},
			target,
		);
	}

	return apps;
}

function createCurrentState({
	services = [] as Service[],
	networks = [] as Network[],
	volumes = [] as Volume[],
	images = services.map((s) => ({
		// Infer images from services by default
		dockerImageId: s.dockerImageId,
		...imageManager.imageFromService(s),
	})) as Image[],
	downloading = [] as string[],
}) {
	const currentApps = createApps({ services, networks, volumes });

	const containerIdsByAppId = services.reduce(
		(ids, s) => ({
			...ids,
			[s.appId]: {
				...ids[s.appId],
				...(s.serviceName &&
					s.containerId && { [s.serviceName]: s.containerId }),
			},
		}),
		{} as { [appId: number]: Dictionary<string> },
	);

	return {
		currentApps,
		availableImages: images,
		downloading,
		containerIdsByAppId,
	};
}

describe('compose/application-manager', () => {
	let testDb: dbHelper.TestDatabase;

	before(async () => {
		testDb = await dbHelper.createDB();

		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'event');
		sinon.stub(log, 'success');

		// Stub methods that depend on external dependencies
		stub(imageManager, 'isCleanupNeeded');
		stub(networkManager, 'supervisorNetworkReady');

		// Stub mkdirp call for service manager bind directory creation
		stub(fsUtils, 'mkdirp').resolves();
	});

	beforeEach(() => {
		// Do not check for cleanup images by default
		(imageManager.isCleanupNeeded as sinon.SinonStub).resolves(false);
		// Do not check for network
		(networkManager.supervisorNetworkReady as sinon.SinonStub).resolves(true);
	});

	afterEach(async () => {
		await testDb.reset();
	});

	after(async () => {
		try {
			await testDb.destroy();
		} catch (e) {
			/* noop */
		}
		// Restore stubbed methods
		sinon.restore();
	});

	it('should init', async () => {
		await applicationManager.initialized;
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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

		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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

		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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

		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [await createService({ appId: 5, serviceName: 'old-service' })],
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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

	it('should infer that we need to create the supervisor network if it does not exist', async () => {
		// stub the networkManager method to fail on finding the supervisor network
		(networkManager.supervisorNetworkReady as sinon.SinonStub).resolves(false);

		const targetApps = createApps(
			{ services: [await createService()], networks: [DEFAULT_NETWORK] },
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [DEFAULT_NETWORK],
		});

		const [
			ensureNetworkStep,
			...nextSteps
		] = await applicationManager.inferNextSteps(currentApps, targetApps, {
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
		// stub the networkManager method to fail on finding the supervisor network
		(networkManager.supervisorNetworkReady as sinon.SinonStub).resolves(false);

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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		// Stub the image manager function
		(imageManager.isCleanupNeeded as sinon.SinonStub).resolves(true);

		const targetApps = createApps(
			{
				services: [await createService()],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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

	it('should infer that an image should be removed if it is no longer referenced in current or target state (only current)', async () => {
		const targetApps = createApps(
			{
				services: [],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
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

	describe('getting applications current state', () => {
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
					status: 'Stopped',
					createdAt: new Date('2021-09-01T12:00:00'),
				},
				{
					// Service without an image should not show on the final state
					appUuid: 'debian',
					commit: 'otherrelease',
					serviceName: 'debian',
					status: 'Stopped',
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
									status: 'Stopped',
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
});
