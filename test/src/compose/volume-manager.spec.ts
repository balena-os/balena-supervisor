import { expect } from 'chai';

import * as sinon from 'sinon';
import {
	createVolume,
	createContainer,
	withMockerode,
} from '../../lib/mockerode';
import * as volumeManager from '../../../src/compose/volume-manager';
import log from '../../../src/lib/supervisor-console';
import Volume from '../../../src/compose/volume';

describe('compose/volume-manager', () => {
	describe('Retrieving volumes from the engine', () => {
		let logDebug: sinon.SinonStub;
		before(() => {
			logDebug = sinon.stub(log, 'debug');
		});
		after(() => {
			logDebug.restore();
		});

		afterEach(() => {
			logDebug.reset();
		});

		it('gets all supervised Volumes', async () => {
			// Setup volume data
			const volumeData = [
				createVolume({
					Name: Volume.generateDockerName(1, 'redis'),
					// Recently created volumes contain io.balena.supervised label
					Labels: { 'io.balena.supervised': '1' },
				}),
				createVolume({
					Name: Volume.generateDockerName(1, 'mysql'),
					// Recently created volumes contain io.balena.supervised label and app-uuid
					Labels: {
						'io.balena.supervised': '1',
						'io.balena.app-uuid': 'deadbeef',
					},
				}),
				createVolume({
					Name: Volume.generateDockerName(1, 'backend'),
					// Old Volumes will not have labels
				}),
				// Volume not created by the Supervisor
				createVolume({ Name: 'user_created_volume' }),
				createVolume({
					Name: 'decoy',
					// Added decoy to really test the inference (should not return)
					Labels: { 'io.balena.supervised': '1' },
				}),
			];

			// Perform test
			await withMockerode(
				async () => {
					await expect(volumeManager.getAll()).to.eventually.deep.equal([
						{
							appId: 1,
							appUuid: undefined,
							config: {
								driver: 'local',
								driverOpts: {},
								labels: {
									'io.balena.supervised': '1',
								},
							},
							name: 'redis',
						},
						{
							appId: 1,
							appUuid: 'deadbeef',
							config: {
								driver: 'local',
								driverOpts: {},
								labels: {
									'io.balena.supervised': '1',
									'io.balena.app-uuid': 'deadbeef',
								},
							},
							name: 'mysql',
						},
						{
							appId: 1,
							appUuid: undefined,
							config: {
								driver: 'local',
								driverOpts: {},
								labels: {},
							},
							name: 'backend',
						},
					]);
					// Check that debug message was logged saying we found a Volume not created by us
					expect(logDebug.lastCall.lastArg).to.equal(
						'Found unmanaged Volume: decoy',
					);
				},
				{ volumes: volumeData },
			);
		});

		it('can parse null Volumes', async () => {
			// Perform test with no volumes
			await withMockerode(async () => {
				await expect(volumeManager.getAll()).to.eventually.deep.equal([]);
			});
		});

		it('gets the volume for specific application', async () => {
			// Setup volume data
			const volumes = [
				createVolume({
					Name: Volume.generateDockerName(111, 'app'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
				createVolume({
					Name: Volume.generateDockerName(222, 'otherApp'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			];
			// Perform test
			await withMockerode(
				async () => {
					await expect(
						volumeManager.getAllByAppId(111),
					).to.eventually.deep.equal([
						{
							appId: 111,
							appUuid: undefined,
							config: {
								driver: 'local',
								driverOpts: {},
								labels: {
									'io.balena.supervised': '1',
								},
							},
							name: 'app',
						},
					]);
				},
				{ volumes },
			);
		});
	});

	describe('Creating volumes', () => {
		it('creates a volume if it does not exist', async () => {
			// Perform test
			await withMockerode(async (mockerode) => {
				// The volume does not exist on the engine before
				expect(
					mockerode.getVolume(Volume.generateDockerName(111, 'main')).inspect(),
				).to.be.rejected;

				// Volume to create
				const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});
				sinon.spy(volume, 'create');

				// Create volume
				await volumeManager.create(volume);

				// Check that the creation function was called
				expect(volume.create).to.have.been.calledOnce;
			});
		});

		it('does not try to create a volume that already exists', async () => {
			// Setup volume data
			const volumes = [
				createVolume({
					Name: Volume.generateDockerName(111, 'main'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			];
			// Perform test
			await withMockerode(
				async () => {
					// Create compose object for volume already set up in mock engine
					const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});
					sinon.spy(volume, 'create');

					// Create volume
					await volumeManager.create(volume);

					// Check volume was not created
					expect(volume.create).to.not.have.been.called;
				},
				{ volumes },
			);
		});
	});

	describe('Removing volumes', () => {
		it('removes a volume if it exists', async () => {
			// Setup volume data
			const volumes = [
				createVolume({
					Name: Volume.generateDockerName(111, 'main'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			];
			// Perform test
			await withMockerode(
				async (mockerode) => {
					// Volume to remove
					const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});
					sinon.spy(volume, 'remove');

					// Remove volume
					await volumeManager.remove(volume);

					// Check volume was removed
					expect(volume.remove).to.be.calledOnce;
					expect(mockerode.removeVolume).to.have.been.calledOnceWith(
						Volume.generateDockerName(111, 'main'),
					);
				},
				{ volumes },
			);
		});

		it('does nothing on removal if the volume does not exist', async () => {
			// Setup volume data
			const volumes = [
				createVolume({
					Name: 'decoy-volume',
				}),
			];

			// Perform test
			await withMockerode(
				async (mockerode) => {
					// Volume to remove
					const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});
					sinon.spy(volume, 'remove');

					// Remove volume
					await expect(volumeManager.remove(volume)).to.not.be.rejected;
					expect(mockerode.removeVolume).to.not.have.been.called;
				},
				{ volumes },
			);
		});
	});

	describe('Removing orphaned volumes', () => {
		it('removes any remaining unreferenced volumes after services have been deleted', async () => {
			// Setup volume data
			const volumes = [
				createVolume({
					Name: 'some-volume',
				}),
				createVolume({
					Name: Volume.generateDockerName(111, 'main'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			];

			await withMockerode(
				async (mockerode) => {
					await volumeManager.removeOrphanedVolumes([]);

					expect(mockerode.removeVolume).to.have.been.calledTwice;
					expect(mockerode.removeVolume).to.have.been.calledWith('some-volume');
					expect(mockerode.removeVolume).to.have.been.calledWith(
						Volume.generateDockerName(111, 'main'),
					);
				},
				{ volumes },
			);
		});

		it('keeps volumes still referenced in target state', async () => {
			// Setup volume data
			const volumes = [
				createVolume({
					Name: 'some-volume',
				}),
				createVolume({
					Name: Volume.generateDockerName(111, 'main'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
				createVolume({
					Name: Volume.generateDockerName(222, 'old'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			];

			await withMockerode(
				async (mockerode) => {
					await volumeManager.removeOrphanedVolumes([
						Volume.generateDockerName(111, 'main'),
					]);

					expect(mockerode.removeVolume).to.have.been.calledTwice;
					expect(mockerode.removeVolume).to.have.been.calledWith('some-volume');
					expect(mockerode.removeVolume).to.have.been.calledWith(
						Volume.generateDockerName(222, 'old'),
					);
				},
				{ volumes },
			);
		});

		it('keeps volumes still referenced by a container', async () => {
			// Setup volume data
			const volumes = [
				createVolume({
					Name: 'some-volume',
				}),
				createVolume({
					Name: Volume.generateDockerName(111, 'main'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			];

			const containers = [
				createContainer({
					Id: 'some-service',
					Mounts: [
						{
							Name: 'some-volume',
						},
					],
				}),
			];

			await withMockerode(
				async (mockerode) => {
					await volumeManager.removeOrphanedVolumes([]);

					// Container that has a volume should not be removed
					expect(mockerode.removeVolume).to.have.been.calledOnceWith(
						Volume.generateDockerName(111, 'main'),
					);
				},
				{ volumes, containers },
			);
		});
	});
});
