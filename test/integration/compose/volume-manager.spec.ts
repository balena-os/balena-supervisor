import { expect } from 'chai';

import * as sinon from 'sinon';
import * as volumeManager from '~/src/compose/volume-manager';
import Volume from '~/src/compose/volume';
import { cleanupDocker, createDockerImage } from '~/test-lib/docker-helper';

import * as Docker from 'dockerode';

describe('compose/volume-manager', () => {
	const docker = new Docker();
	after(async () => {
		await cleanupDocker({ docker });
	});

	describe('Retrieving volumes from the engine', () => {
		it('gets all supervised Volumes', async () => {
			// Setup volume data
			await Promise.all([
				docker.createVolume({
					Name: Volume.generateDockerName(1, 'redis'),
					// Recently created volumes contain io.balena.supervised label
					Labels: { 'io.balena.supervised': '1' },
				}),
				docker.createVolume({
					Name: Volume.generateDockerName(1, 'mysql'),
					// Recently created volumes contain io.balena.supervised label and app-uuid
					Labels: {
						'io.balena.supervised': '1',
						'io.balena.app-uuid': 'deadbeef',
					},
				}),
				docker.createVolume({
					Name: Volume.generateDockerName(2, 'backend'),
					// Old Volumes will not have labels
				}),
				// Volume not created by the Supervisor
				docker.createVolume({ Name: 'user_created_volume' }),
				docker.createVolume({
					Name: 'decoy',
					// Added decoy to really test the inference (should not return)
					Labels: { 'io.balena.supervised': '1' },
				}),
			]);

			// Perform test
			await expect(volumeManager.getAll()).to.eventually.have.deep.members([
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
					appId: 2,
					appUuid: undefined,
					config: {
						driver: 'local',
						driverOpts: {},
						labels: {},
					},
					name: 'backend',
				},
			]);

			// Cleanup volumes
			await Promise.all([
				docker.getVolume(Volume.generateDockerName(1, 'redis')).remove(),
				docker.getVolume(Volume.generateDockerName(1, 'mysql')).remove(),
				docker.getVolume(Volume.generateDockerName(2, 'backend')).remove(),
				docker.getVolume('user_created_volume').remove(),
				docker.getVolume('decoy').remove(),
			]);
		});

		it('can parse null Volumes', async () => {
			// Perform test with no volumes
			await expect(volumeManager.getAll()).to.eventually.deep.equal([]);
		});

		it('gets the volume for specific application', async () => {
			// Setup volume data
			await Promise.all([
				docker.createVolume({
					Name: Volume.generateDockerName(111, 'app'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
				docker.createVolume({
					Name: Volume.generateDockerName(222, 'otherApp'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			]);

			// Perform test
			await expect(volumeManager.getAllByAppId(111)).to.eventually.deep.equal([
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

			// Cleanup volumes
			await Promise.all([
				docker.getVolume(Volume.generateDockerName(111, 'app')).remove(),
				docker.getVolume(Volume.generateDockerName(222, 'otherApp')).remove(),
			]);
		});
	});

	describe('Creating volumes', () => {
		it('creates a volume if it does not exist', async () => {
			// The volume does not exist on the engine before
			await expect(
				docker.getVolume(Volume.generateDockerName(111, 'main')).inspect(),
			).to.be.rejected;

			// Volume to create
			const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});

			// Create volume
			await volumeManager.create(volume);

			// Check the volume should have been created
			await expect(
				docker.getVolume(Volume.generateDockerName(111, 'main')).inspect(),
			).to.not.be.rejected;

			// Cleanup volumes
			await Promise.all([
				docker.getVolume(Volume.generateDockerName(111, 'main')).remove(),
			]);
		});

		it('does not try to create a volume that already exists', async () => {
			// Setup volume data
			await docker.createVolume({
				Name: Volume.generateDockerName(111, 'main'),
				Labels: {
					'io.balena.supervised': '1',
				},
			});

			// Create compose object for volume already set up in mock engine
			const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});
			sinon.spy(volume, 'create');

			// Create volume
			await volumeManager.create(volume);

			// Check volume was not created
			expect(volume.create).to.not.have.been.called;

			// Cleanup volumes
			await Promise.all([
				docker.getVolume(Volume.generateDockerName(111, 'main')).remove(),
			]);
		});
	});

	describe('Removing volumes', () => {
		it('removes a volume if it exists', async () => {
			// Setup volume data
			await Promise.all([
				docker.createVolume({
					Name: Volume.generateDockerName(111, 'main'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
			]);

			// Volume to remove
			const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});

			// Remove volume
			await volumeManager.remove(volume);

			// Check volume was removed
			await expect(
				docker.getVolume(Volume.generateDockerName(111, 'main')).inspect(),
			).to.be.rejected;
		});

		it('does nothing on removal if the volume does not exist', async () => {
			// Setup volume data
			await Promise.all([
				docker.createVolume({
					Name: 'decoy-volume',
				}),
			]);

			// Volume to remove
			const volume = Volume.fromComposeObject('main', 111, 'deadbeef', {});

			// Remove volume
			await expect(volumeManager.remove(volume)).to.not.be.rejected;

			// Cleanup volumes
			await Promise.all([docker.getVolume('decoy-volume').remove()]);
		});
	});

	describe('Removing orphaned volumes', () => {
		it('removes any remaining unreferenced volumes after services have been deleted', async () => {
			// Setup volume data
			await Promise.all([
				docker.createVolume({
					Name: 'some-volume',
				}),
				// This volume is still referenced in the target state
				docker.createVolume({
					Name: Volume.generateDockerName(111, 'main'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
				docker.createVolume({
					Name: Volume.generateDockerName(222, 'old'),
					Labels: {
						'io.balena.supervised': '1',
					},
				}),
				// This volume is referenced by a container
				docker.createVolume({
					Name: 'other-volume',
				}),
			]);

			// Create an empty image
			await createDockerImage('hello', ['io.balena.testing=1'], docker);

			// Create a container from the image
			const { id: containerId } = await docker.createContainer({
				Image: 'hello',
				Cmd: ['true'],
				HostConfig: {
					Binds: ['other-volume:/data'],
				},
			});

			await expect(
				volumeManager.removeOrphanedVolumes([
					// Keep any volumes in the target state
					Volume.generateDockerName(111, 'main'),
				]),
			).to.not.be.rejected;

			// All volumes should have been deleted
			expect(await docker.listVolumes())
				.to.have.property('Volumes')
				.that.has.lengthOf(2);

			// Reference volume should have been kept
			await expect(
				docker.getVolume(Volume.generateDockerName(111, 'main')).inspect(),
			).to.not.be.rejected;
			await expect(docker.getVolume('other-volume').inspect()).to.not.be
				.rejected;

			// Cleanup
			await Promise.all([
				docker.getVolume(Volume.generateDockerName(111, 'main')).remove(),
				docker.getContainer(containerId).remove(),
			]);

			await Promise.all([
				docker.getImage('hello').remove(),
				docker.getVolume('other-volume').remove(),
			]);
		});
	});
});
