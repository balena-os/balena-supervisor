import { expect } from 'chai';
import Volume from '~/src/compose/volume';

describe('compose/volume: unit tests', () => {
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
});
