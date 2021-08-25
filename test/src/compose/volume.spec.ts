import { expect } from 'chai';
import { SinonStub, stub } from 'sinon';
import Volume from '../../../src/compose/volume';
import * as logTypes from '../../../src/lib/log-types';
import * as logger from '../../../src/logger';

import { createVolume, withMockerode } from '../../lib/mockerode';

describe('compose/volume', () => {
	describe('creating a volume from a compose object', () => {
		it('should use proper defaults when no compose configuration is provided', () => {
			const volume = Volume.fromComposeObject(
				'my_volume',
				1234,
				'deadbeef',
				{},
			);

			expect(volume.name).to.equal('my_volume');
			expect(volume.appId).to.equal(1234);
			expect(volume.appUuid).to.equal('deadbeef');
			expect(volume.config).to.deep.equal({
				driver: 'local',
				driverOpts: {},
				labels: {
					'io.balena.supervised': 'true',
					'io.balena.app-uuid': 'deadbeef',
				},
			});
		});

		it('should correctly parse compose volumes without an explicit driver', () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				'deadbeef',
				{
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
			);

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
					'io.balena.app-uuid': 'deadbeef',
					'my-label': 'test-label',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driverOpts')
				.that.deep.equals({
					opt1: 'test',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driver')
				.that.equals('local');
		});

		it('should correctly parse compose volumes with an explicit driver', () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				'deadbeef',
				{
					driver: 'other',
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
			);

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
					'io.balena.app-uuid': 'deadbeef',
					'my-label': 'test-label',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driverOpts')
				.that.deep.equals({
					opt1: 'test',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driver')
				.that.equals('other');
		});
	});

	describe('creating a volume instance from a docker volume', () => {
		it('should correctly parse app id from volume name', () => {
			const volume = Volume.fromDockerVolume({
				Driver: 'local',
				Name: '1234_my_volume',
				Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
				Labels: {},
				Options: {},
				Scope: 'local',
			});

			expect(volume.name).to.equal('my_volume');
			expect(volume.appId).to.equal(1234);
		});

		it('should fail if volume name is not properly formatted', () => {
			expect(() =>
				Volume.fromDockerVolume({
					Driver: 'local',
					Name: 'non_supervised_volume',
					Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
					Labels: {},
					Options: {},
					Scope: 'local',
				}),
			).to.throw;
		});

		it('should correctly parse docker volumes', () => {
			const volume = Volume.fromDockerVolume({
				Driver: 'local',
				Labels: {
					'io.balena.supervised': 'true',
					'io.balena.app-uuid': 'deadbeef',
				},
				Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
				Name: '1032480_one_volume',
				Options: {},
				Scope: 'local',
			});

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume).to.have.property('appUuid').that.equals('deadbeef');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
					'io.balena.app-uuid': 'deadbeef',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driverOpts')
				.that.deep.equals({});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driver')
				.that.equals('local');
		});
	});

	describe('creating a docker volume from options', () => {
		before(() => {
			stub(logger, 'logSystemEvent');
		});

		afterEach(() => {
			(logger.logSystemEvent as SinonStub).reset();
		});

		after(() => {
			(logger.logSystemEvent as SinonStub).restore();
		});

		it('should use defaults to create the volume when no options are given', async () => {
			await withMockerode(async (mockerode) => {
				const volume = Volume.fromComposeObject(
					'one_volume',
					1032480,
					'deadbeef',
				);

				await volume.create();

				expect(mockerode.createVolume).to.have.been.calledOnceWith({
					Name: '1032480_one_volume',
					Driver: 'local',
					Labels: {
						'io.balena.supervised': 'true',
						'io.balena.app-uuid': 'deadbeef',
					},
					DriverOpts: {},
				});
			});
		});

		it('should pass configuration options to the engine', async () => {
			await withMockerode(async (mockerode) => {
				const volume = Volume.fromComposeObject(
					'one_volume',
					1032480,
					'deadbeef',
					{
						driver_opts: {
							opt1: 'test',
						},
						labels: {
							'my-label': 'test-label',
						},
					},
				);

				await volume.create();

				expect(mockerode.createVolume).to.have.been.calledOnceWith({
					Name: '1032480_one_volume',
					Driver: 'local',
					Labels: {
						'my-label': 'test-label',
						'io.balena.supervised': 'true',
						'io.balena.app-uuid': 'deadbeef',
					},
					DriverOpts: {
						opt1: 'test',
					},
				});

				expect(logger.logSystemEvent).to.have.been.calledOnceWith(
					logTypes.createVolume,
				);
			});
		});

		it('should log successful volume creation to the cloud', async () => {
			await withMockerode(async (mockerode) => {
				const volume = Volume.fromComposeObject(
					'one_volume',
					1032480,
					'deadbeef',
				);

				await volume.create();

				expect(mockerode.createVolume).to.have.been.calledOnce;
				expect(logger.logSystemEvent).to.have.been.calledOnceWith(
					logTypes.createVolume,
				);
			});
		});
	});

	describe('comparing volume configuration', () => {
		it('should ignore name and supervisor labels in the comparison', () => {
			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef').isEqualConfig(
					Volume.fromComposeObject('bbb', 4567, 'deadbeef', {
						driver: 'local',
						driver_opts: {},
					}),
				),
			).to.be.true;

			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef').isEqualConfig(
					Volume.fromComposeObject('bbb', 4567, 'deadc0de'),
				),
			).to.be.true;

			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef').isEqualConfig(
					Volume.fromDockerVolume({
						Name: '1234_aaa',
						Driver: 'local',
						Labels: {
							'io.balena.supervised': 'true',
							'io.balena.app-uuid': 'deadbeef',
						},
						Options: {},
						Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
						Scope: 'local',
					}),
				),
			).to.be.true;

			// the app-uuid should be omitted from the comparison
			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef').isEqualConfig(
					Volume.fromDockerVolume({
						Name: '1234_aaa',
						Driver: 'local',
						Labels: {
							'io.balena.supervised': 'true',
						},
						Options: {},
						Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
						Scope: 'local',
					}),
				),
			).to.be.true;

			expect(
				Volume.fromComposeObject('aaa', 1234, null as any).isEqualConfig(
					Volume.fromDockerVolume({
						Name: '4567_bbb',
						Driver: 'local',
						Labels: {
							'io.balena.supervised': 'true',
						},
						Options: {},
						Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
						Scope: 'local',
					}),
				),
			).to.be.true;

			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef').isEqualConfig(
					Volume.fromDockerVolume({
						Name: '1234_aaa',
						Driver: 'local',
						Labels: {
							'some.other.label': '123',
							'io.balena.supervised': 'true',
							'io.balena.app-uuid': 'deadbeef',
						},
						Options: {},
						Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
						Scope: 'local',
					}),
				),
			).to.be.false;
		});

		it('should compare based on driver configuration and options', () => {
			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef').isEqualConfig(
					Volume.fromComposeObject('aaa', 1234, 'deadbeef', {
						driver: 'other',
						driver_opts: {},
					}),
				),
			).to.be.false;

			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef', {
					driver: 'other',
				}).isEqualConfig(
					Volume.fromComposeObject('aaa', 1234, 'deadbeef', {
						driver: 'other',
						driver_opts: {},
					}),
				),
			).to.be.true;

			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef', {}).isEqualConfig(
					Volume.fromComposeObject('aaa', 1234, 'deadbeef', {
						driver_opts: { opt: '123' },
					}),
				),
			).to.be.false;

			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef', {
					driver: 'other',
					labels: { 'some.other.label': '123' },
					driver_opts: { 'some-opt': '123' },
				}).isEqualConfig(
					Volume.fromDockerVolume({
						Name: '1234_aaa',
						Driver: 'other',
						Labels: {
							'some.other.label': '123',
							'io.balena.supervised': 'true',
						},
						Options: {},
						Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
						Scope: 'local',
					}),
				),
			).to.be.false;

			expect(
				Volume.fromComposeObject('aaa', 1234, 'deadbeef', {
					driver: 'other',
					labels: { 'some.other.label': '123' },
					driver_opts: { 'some-opt': '123' },
				}).isEqualConfig(
					Volume.fromDockerVolume({
						Name: '1234_aaa',
						Driver: 'other',
						Labels: {
							'some.other.label': '123',
							'io.balena.supervised': 'true',
						},
						Options: { 'some-opt': '123' },
						Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
						Scope: 'local',
					}),
				),
			).to.be.true;
		});
	});

	describe('removing volumes', () => {
		before(() => {
			stub(logger, 'logSystemEvent');
		});

		afterEach(() => {
			(logger.logSystemEvent as SinonStub).reset();
		});

		after(() => {
			(logger.logSystemEvent as SinonStub).restore();
		});

		it('should remove the volume from the engine if it exists', async () => {
			const dockerVolume = createVolume({
				Name: '1234_aaa',
			});

			await withMockerode(
				async (mockerode) => {
					const volume = Volume.fromComposeObject('aaa', 1234, 'deadbeef');

					// Check engine state before (this is really to test that mockerode is doing its job)
					expect((await mockerode.listVolumes()).Volumes).to.have.lengthOf(1);
					expect(await mockerode.getVolume('1234_aaa').inspect()).to.deep.equal(
						dockerVolume.inspectInfo,
					);

					// Remove the volume
					await volume.remove();

					// Check that the remove method was called
					expect(mockerode.removeVolume).to.have.been.calledOnceWith(
						'1234_aaa',
					);
				},
				{ volumes: [dockerVolume] },
			);
		});

		it('should report the volume removal as a system event', async () => {
			const dockerVolume = createVolume({
				Name: '1234_aaa',
			});

			await withMockerode(
				async (mockerode) => {
					const volume = Volume.fromComposeObject('aaa', 1234, 'deadbeef');

					// Check engine state before
					expect((await mockerode.listVolumes()).Volumes).to.have.lengthOf(1);

					// Remove the volume
					await volume.remove();

					// Check that the remove method was called
					expect(mockerode.removeVolume).to.have.been.calledOnceWith(
						'1234_aaa',
					);

					// Check that log entry was generated
					expect(logger.logSystemEvent).to.have.been.calledOnceWith(
						logTypes.removeVolume,
					);
				},
				{ volumes: [dockerVolume] },
			);
		});

		it('should report an error if the volume does not exist', async () => {
			const dockerVolume = createVolume({
				Name: '4567_bbb',
			});
			await withMockerode(
				async (mockerode) => {
					const volume = Volume.fromComposeObject('aaa', 1234, 'deadbeef');

					// Check engine state before
					expect((await mockerode.listVolumes()).Volumes).to.have.lengthOf(1);

					// Remove the volume, this should not throw
					await expect(volume.remove()).to.not.be.rejected;

					// Check that the remove method was called
					expect(mockerode.removeVolume).to.not.have.been.called;

					// Check that log entry was generated
					expect(logger.logSystemEvent).to.have.been.calledWith(
						logTypes.removeVolumeError,
					);
				},
				{ volumes: [dockerVolume] },
			);
		});

		it('should report an error if a problem happens while removing the volume', async () => {
			const dockerVolume = createVolume({
				Name: '1234_aaa',
			});
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
