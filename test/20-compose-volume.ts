import { expect } from 'chai';
import { stub } from 'sinon';

import Volume from '../src/compose/volume';
import logTypes = require('../src/lib/log-types');

const fakeLogger = {
	logSystemMessage: stub(),
	logSystemEvent: stub(),
};
const fakeDocker = {
	createVolume: stub(),
};

const opts: any = { logger: fakeLogger, docker: fakeDocker };

describe('Compose volumes', () => {
	describe('Parsing volumes', () => {
		it('should correctly parse docker volumes', () => {
			const volume = Volume.fromDockerVolume(opts, {
				Driver: 'local',
				Labels: {
					'io.balena.supervised': 'true',
				},
				Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
				Name: '1032480_one_volume',
				Options: {},
				Scope: 'local',
			});

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
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

		it('should correctly parse compose volumes without an explicit driver', () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				{
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
				opts,
			);

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
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
				{
					driver: 'other',
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
				opts,
			);

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
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

	describe('Generating docker options', () => {
		afterEach(() => {
			fakeDocker.createVolume.reset();
			fakeLogger.logSystemEvent.reset();
			fakeLogger.logSystemMessage.reset();
		});
		it('should correctly generate docker options', async () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				{
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
				opts,
			);

			await volume.create();
			expect(
				fakeDocker.createVolume.calledWith({
					Labels: {
						'my-label': 'test-label',
						'io.balena.supervised': 'true',
					},
					Options: {
						opt1: 'test',
					},
				}),
			);

			expect(fakeLogger.logSystemEvent.calledWith(logTypes.createVolume));
		});
	});
});
