import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import { Volume } from '~/src/compose/volume';
import * as logTypes from '~/lib/log-types';
import * as logger from '~/src/logger';

import Docker from 'dockerode';

import { createVolume, withMockerode } from '~/test-lib/mockerode';

describe('compose/volume: integration tests', () => {
	const docker = new Docker();

	describe('creating and removing docker volumes', () => {
		before(() => {
			// TODO: can we spy the actual log stream instead of stubbing and using
			// implementation details?
			stub(logger, 'logSystemEvent');
		});

		afterEach(() => {
			(logger.logSystemEvent as SinonStub).reset();
		});

		after(async () => {
			const { Volumes: allVolumes } = await docker.listVolumes();
			await Promise.all(
				allVolumes.map(({ Name }) => docker.getVolume(Name).remove()),
			);
			(logger.logSystemEvent as SinonStub).restore();
		});

		it('should use defaults to create the volume when no options are given', async () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				'deadbeef',
			);

			// Create the volume
			await volume.create();

			const dockerVolumeName = Volume.generateDockerName(
				volume.appId,
				volume.name,
			);
			// This should not throw
			const dockerVolume = await docker.getVolume(dockerVolumeName).inspect();

			expect(dockerVolume).to.deep.include({
				Name: dockerVolumeName,
				Driver: 'local',
				Labels: {
					'io.balena.supervised': 'true',
					'io.balena.app-uuid': 'deadbeef',
				},
			});

			expect(logger.logSystemEvent).to.have.been.calledOnceWith(
				logTypes.createVolume,
			);

			// Test volume removal
			await volume.remove();

			// The volume should no longer exist
			await expect(docker.getVolume(dockerVolumeName).inspect()).to.be.rejected;

			// Check that log entry was generated
			expect(logger.logSystemEvent).to.have.been.calledWith(
				logTypes.removeVolume,
			);
		});

		it('should pass configuration options to the engine', async () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				'deadbeef',
				{
					driver: 'local',
					driver_opts: {
						type: 'tmpfs',
						device: 'tmpfs',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
			);

			await volume.create();

			const dockerVolumeName = Volume.generateDockerName(
				volume.appId,
				volume.name,
			);
			// This should not throw
			const dockerVolume = await docker.getVolume(dockerVolumeName).inspect();

			expect(dockerVolume).to.deep.include({
				Name: dockerVolumeName,
				Driver: 'local',
				Labels: {
					'my-label': 'test-label',
					'io.balena.supervised': 'true',
					'io.balena.app-uuid': 'deadbeef',
				},
				Options: {
					device: 'tmpfs',
					type: 'tmpfs',
				},
			});

			expect(logger.logSystemEvent).to.have.been.calledOnceWith(
				logTypes.createVolume,
			);

			// Test volume removal
			await volume.remove();

			// The volume should no longer exist
			await expect(docker.getVolume(dockerVolumeName).inspect()).to.be.rejected;

			// Check that log entry was generated
			expect(logger.logSystemEvent).to.have.been.calledWith(
				logTypes.removeVolume,
			);
		});

		it('should report an error if the volume does not exist', async () => {
			const volume = Volume.fromComposeObject('aaa', 1234, 'deadbeef');

			const dockerVolumeName = Volume.generateDockerName(
				volume.appId,
				volume.name,
			);

			// The volume should not exist before
			await expect(docker.getVolume(dockerVolumeName).inspect()).to.be.rejected;

			// Remove the volume, this should not throw
			await expect(volume.remove()).to.not.be.rejected;

			// Check that log entry was generated
			expect(logger.logSystemEvent).to.have.been.calledWith(
				logTypes.removeVolumeError,
			);
		});

		it('should report an error if a problem happens while removing the volume', async () => {
			const dockerVolume = createVolume({
				Name: '1234_aaa',
			});

			// We only use mockerode to simulate errors
			await withMockerode(
				async (mockerode) => {
					const volume = Volume.fromComposeObject('aaa', 1234, 'deadbeef');

					// Stub the mockerode method to fail
					mockerode.removeVolume.rejects('Something bad happened');

					// Check engine state before
					expect((await mockerode.listVolumes()).Volumes).to.have.lengthOf(1);

					// Remove the volume, this should not throw
					await expect(volume.remove()).to.not.be.rejected;

					// Check that log entry was generated
					expect(logger.logSystemEvent).to.have.been.calledWith(
						logTypes.removeVolumeError,
					);
				},
				{ volumes: [dockerVolume] },
			);
		});
	});
});
