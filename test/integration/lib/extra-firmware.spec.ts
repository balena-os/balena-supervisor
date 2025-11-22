import { expect } from 'chai';
import { testfs, type TestFs } from 'mocha-pod';
import { promises as fs } from 'fs';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import Docker from 'dockerode';

import * as extraFirmware from '~/lib/extra-firmware';
import ConfigJsonConfigBackend from '~/src/config/configJson';
import { schema } from '~/src/config/schema';
import log from '~/lib/supervisor-console';
import { InternalInconsistencyError } from '~/lib/errors';

describe('lib/extra-firmware', () => {
	const CONFIG_PATH = '/mnt/boot/config.json';
	const docker = new Docker();
	let configJsonBackend: ConfigJsonConfigBackend;
	let tfs: TestFs.Enabled;

	describe('isInitialized', () => {
		it('should return true if extra firmware volume exists and config.json is configured to use it', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: {
							extraFirmwareVol: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
						},
					},
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);
			await docker.createVolume({
				Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
			});

			expect(await extraFirmware.isInitialized(configJsonBackend)).to.be.true;

			await docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).remove();
			await tfs.restore();
		});

		it('should return false if extra firmware volume does not exist', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: {
							extraFirmwareVol: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
						},
					},
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);

			expect(await extraFirmware.isInitialized(configJsonBackend)).to.be.false;

			await tfs.restore();
		});

		it('should return false if config.json is not configured to use extra firmware volume', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: {
							extraFirmwareVol: 'old-extra-firmware',
						},
					},
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);
			await docker.createVolume({
				Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
			});

			expect(await extraFirmware.isInitialized(configJsonBackend)).to.be.false;

			await docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).remove();
			await tfs.restore();
		});

		it('should return false if config.json "os" key does not exist', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);
			await docker.createVolume({
				Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
			});

			expect(await extraFirmware.isInitialized(configJsonBackend)).to.be.false;

			await docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).remove();
			await tfs.restore();
		});

		it('should return false if config.json "os" key is malformed', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: 'malformed',
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);
			await docker.createVolume({
				Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
			});

			expect(await extraFirmware.isInitialized(configJsonBackend)).to.be.false;

			await docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).remove();
			await tfs.restore();
		});

		it('should return false if config.json "os.kernel" key is malformed', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: 'malformed',
					},
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);
			await docker.createVolume({
				Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
			});

			expect(await extraFirmware.isInitialized(configJsonBackend)).to.be.false;

			await docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).remove();
			await tfs.restore();
		});

		it('should throw error if config.json is corrupted or an unexpected format', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: 'not json',
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);
			await docker.createVolume({
				Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
			});

			await expect(
				extraFirmware.isInitialized(configJsonBackend),
			).to.be.rejectedWith(
				InternalInconsistencyError,
				'Error reading config.json while initializing extra firmware volume: Unexpected token \'o\', "not json" is not valid JSON',
			);

			await docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).remove();
			await tfs.restore();
		});

		it('should throw error if error getting extra firmware volume', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: {
							extraFirmwareVol: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
						},
					},
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);
			await docker.createVolume({
				Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
			});
			const inspectStub = stub(Docker.Volume.prototype, 'inspect').throws(
				new Error('Test error while getting volume'),
			);

			await expect(
				extraFirmware.isInitialized(configJsonBackend),
			).to.be.rejectedWith(
				InternalInconsistencyError,
				'Error getting extra firmware volume: Test error while getting volume',
			);

			inspectStub.restore();
			await docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).remove();
			await tfs.restore();
		});
	});

	describe('configuration', () => {
		it('should configure extra firmware volume in config.json', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);

			await extraFirmware.initialize(configJsonBackend);

			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: {
							extraFirmwareVol: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
						},
					},
				}),
			);

			await tfs.restore();
		});

		it('should update extra firmware volume name while logging change', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: {
							extraFirmwareVol: 'old-extra-firmware',
						},
					},
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);

			await extraFirmware.initialize(configJsonBackend);

			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: {
							extraFirmwareVol: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
						},
					},
				}),
			);
			expect(log.info as SinonStub).to.have.been.calledWith(
				'Extra firmware volume name changed from old-extra-firmware to extra-firmware',
			);

			await tfs.restore();
		});

		it('should warn if config.json "os" key is malformed', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: 'malformed',
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);

			await extraFirmware.initialize(configJsonBackend);

			// config.json shouldn't be modified if malformed,
			// in case it's malformed due to corruption.
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: 'malformed',
				}),
			);
			expect(log.warn as SinonStub).to.have.been.calledWith(
				'Malformed config.json: os is not an object',
			);

			await tfs.restore();
		});

		it('should error if config.json "os.kernel" key is malformed', async () => {
			tfs = await testfs({
				[CONFIG_PATH]: JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: 'malformed',
					},
				}),
			}).enable();
			configJsonBackend = new ConfigJsonConfigBackend(schema);

			await extraFirmware.initialize(configJsonBackend);

			// config.json shouldn't be modified if malformed,
			// in case it's malformed due to corruption.
			expect(await fs.readFile(CONFIG_PATH, 'utf8')).to.equal(
				JSON.stringify({
					apiEndpoint: 'foo',
					deviceId: 123,
					os: {
						kernel: 'malformed',
					},
				}),
			);
			expect(log.warn as SinonStub).to.have.been.calledWith(
				'Malformed config.json: os.kernel is not an object',
			);

			await tfs.restore();
		});
	});

	describe('volume management', () => {
		afterEach(async () => {
			// Clean up any leftover extra-firmware volume
			try {
				await docker
					.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME)
					.remove();
			} catch {
				// Ignore if volume doesn't exist
			}
		});

		describe('create', () => {
			it('should create the extra-firmware volume', async () => {
				// Volume should not exist initially
				try {
					await docker
						.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME)
						.remove();
				} catch {
					// Ignore if volume doesn't exist
				}
				await expect(
					docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).inspect(),
				).to.be.rejected;

				// Create the volume
				await extraFirmware.create();

				// Volume should now exist
				const volumeInfo = await docker
					.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME)
					.inspect();
				expect(volumeInfo).to.have.property(
					'Name',
					extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
				);
			});

			it('should not throw if volume already exists', async () => {
				// Create the volume first
				await docker.createVolume({
					Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
				});

				// Calling create again should not throw
				await expect(extraFirmware.create()).to.not.be.rejected;
			});
		});

		describe('remove', () => {
			it('should remove the extra-firmware volume if it exists', async () => {
				// Create the volume first
				await docker.createVolume({
					Name: extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME,
				});

				// Volume should exist
				await expect(
					docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).inspect(),
				).to.not.be.rejected;

				// Remove the volume
				await extraFirmware.remove();

				// Volume should no longer exist
				await expect(
					docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).inspect(),
				).to.be.rejected;
			});

			it('should not throw if volume does not exist', async () => {
				// Volume should not exist
				await expect(
					docker.getVolume(extraFirmware.EXTRA_FIRMWARE_VOLUME_NAME).inspect(),
				).to.be.rejected;

				// Calling remove should not throw
				await expect(extraFirmware.remove()).to.not.be.rejected;
			});
		});
	});
});
