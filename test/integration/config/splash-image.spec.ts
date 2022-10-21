import { promises as fs } from 'fs';
import { testfs, TestFs } from 'mocha-pod';

import { expect } from 'chai';
import * as hostUtils from '~/lib/host-utils';
import { SplashImage } from '~/src/config/backends/splash-image';
import log from '~/lib/supervisor-console';

describe('config/splash-image', () => {
	const backend = new SplashImage();
	const defaultLogo =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/wQDLA+84AAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
	const logo =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/TQBcNTh/AAAAAXRSTlPM0jRW/QAAAApJREFUeJxjYgAAAAYAAzY3fKgAAAAASUVORK5CYII=';
	const uri = `data:image/png;base64,${logo}`;

	describe('initialise', () => {
		let tfs: TestFs.Enabled;

		beforeEach(async () => {
			tfs = await testfs(
				{
					[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
						defaultLogo,
						'base64',
					),
				},
				{ cleanup: [hostUtils.pathOnBoot('splash/balena-logo-default.png')] },
			).enable();
		});

		afterEach(async () => {
			await tfs.restore();
		});

		it('should make a copy of the existing boot image on initialise if not yet created', async () => {
			await expect(
				fs.access(hostUtils.pathOnBoot('splash/balena-logo-default.png')),
				'logo copy should not exist before first initialization',
			).to.be.rejected;

			// Do the initialization
			await backend.initialise();

			// The copy should exist after the test and equal defaultLogo
			await expect(
				fs.access(hostUtils.pathOnBoot('splash/balena-logo-default.png')),
				'logo copy should exist after initialization',
			).to.not.be.rejected;

			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo-default.png'),
					'base64',
				),
			).to.equal(defaultLogo);
		});

		it('should skip initialization if the default image already exists', async () => {
			// Write a different logo as default
			await fs.writeFile(
				hostUtils.pathOnBoot('splash/balena-logo-default.png'),
				Buffer.from(logo, 'base64'),
			);
			// Do the initialization
			await backend.initialise();

			// The copy should exist after the test and be equal to logo (it should not) have
			// been changed
			await expect(
				fs.access(hostUtils.pathOnBoot('splash/balena-logo-default.png')),
				'logo copy still exists after initialization',
			).to.not.be.rejected;

			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo-default.png'),
					'base64',
				),
			).to.equal(logo);
		});

		it('should warn about failed initialization if there is no default image on the device', async () => {
			await fs.unlink(hostUtils.pathOnBoot('splash/balena-logo.png'));

			// Do the initialization
			await backend.initialise();

			expect(log.warn).to.be.calledOnceWith(
				'Could not initialise splash image backend',
			);
		});
	});

	describe('getBootConfig', () => {
		it('should return an empty object if the current logo matches the default logo', async () => {
			const tfs = await testfs({
				// Both the logo and the copy resolve to the same value
				[hostUtils.pathOnBoot('splash/resin-logo.png')]: Buffer.from(
					logo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					logo,
					'base64',
				),
			}).enable();

			// The default logo resolves to the same value as the current logo
			expect(await backend.getBootConfig()).to.deep.equal({});

			await tfs.restore();
		});

		it('should read the splash image from resin-logo.png if available', async () => {
			const tfs = await testfs({
				// resin logo and balena-logo-default are different which means the current logo
				// is a custom image
				[hostUtils.pathOnBoot('splash/resin-logo.png')]: Buffer.from(
					logo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			expect(await backend.getBootConfig()).to.deep.equal({
				image: uri,
			});

			await tfs.restore();
		});

		it('should read the splash image from balena-logo.png if available', async () => {
			const tfs = await testfs({
				// balena-logo and balena-logo-default are different which means the current logo
				// is a custom image
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					logo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			expect(await backend.getBootConfig()).to.deep.equal({
				image: uri,
			});

			await tfs.restore();
		});

		it('should read the splash image from balena-logo.png even if resin-logo.png exists', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					logo,
					'base64',
				),
				// resin-logo has the same value as default, but it is ignored since balena-logo exists
				[hostUtils.pathOnBoot('splash/resin-logo.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			expect(await backend.getBootConfig()).to.deep.equal({
				// balena-logo is the value read
				image: uri,
			});

			await tfs.restore();
		});

		it('should catch readDir errors', async () => {
			// Remove the directory before the tests to cause getBootConfig to fail
			await fs
				.rm(hostUtils.pathOnBoot('splash'), { recursive: true, force: true })
				.catch(() => {
					/* noop */
				});

			expect(await backend.getBootConfig()).to.deep.equal({});
			expect(log.warn).to.be.calledOnceWith('Failed to read splash image:');
		});

		it('should catch readFile errors', async () => {
			await expect(
				fs.access(hostUtils.pathOnBoot('splash/balena-logo.png')),
				'logo does not exist before getting boot config',
			).to.be.rejected;
			await expect(
				fs.access(hostUtils.pathOnBoot('splash/resin-logo.png')),
				'logo does not exist before getting boot config',
			).to.be.rejected;

			expect(await backend.getBootConfig()).to.deep.equal({});
			expect(log.warn).to.be.calledOnceWith('Failed to read splash image:');
		});
	});

	describe('setBootConfig', () => {
		it('should write the given image to resin-logo.png if set', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/resin-logo.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			await backend.setBootConfig({ image: uri });

			// Since resin-logo already exists we use that to write
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/resin-logo.png'),
					'base64',
				),
			).to.equal(logo);

			await tfs.restore();
		});

		it('should write the given image to balena-logo.png if set', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/resin-logo.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			await backend.setBootConfig({ image: uri });

			// Resin logo should not have changed
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/resin-logo.png'),
					'base64',
				),
			).to.equal(defaultLogo);

			// balena-logo is used as the correct location
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo.png'),
					'base64',
				),
			).to.equal(logo);

			await tfs.restore();
		});

		it('should accept just a base64 as an image', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			// We use just the base64 image instead of the data uri
			await backend.setBootConfig({ image: logo });

			// The file should have changed
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo.png'),
					'base64',
				),
			).to.equal(logo);

			await tfs.restore();
		});

		it('should restore balena-logo.png if image arg is unset', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					logo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			// setBootConfig with an empty object should delete the iamge
			await backend.setBootConfig({});

			// The default should have been reverted to the default value
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo.png'),
					'base64',
				),
			).to.equal(defaultLogo);

			await tfs.restore();
		});

		it('should restore resin-logo.png if image arg is unset', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/resin-logo.png')]: Buffer.from(
					logo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			// setBootConfig with an empty object should delete the iamge
			await backend.setBootConfig({});

			// The default should have been reverted to the default value
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/resin-logo.png'),
					'base64',
				),
			).to.equal(defaultLogo);

			await tfs.restore();
		});

		it('should restore balena-logo.png if image arg is empty', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					logo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			// setBootConfig with an empty image should also restore the default
			await backend.setBootConfig({ image: '' });

			// The default should have been reverted to the default value
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo.png'),
					'base64',
				),
			).to.equal(defaultLogo);

			await tfs.restore();
		});

		// TODO: note that ignoring a value on the backend will cause the supervisor
		// to go into a loop trying to apply target state, as the current will never match
		// the target. The image needs to be validated cloud side, and as a last line of defense,
		// when receiving the target state
		it('should ignore the value if arg is not a valid base64 string', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			// We pass something that is not an image
			await backend.setBootConfig({ image: 'somestring' });

			// The file should NOT have changed
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo.png'),
					'base64',
				),
			).to.equal(defaultLogo);

			await tfs.restore();
		});

		it('should ignore the value if image is not a valid PNG file', async () => {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('splash/balena-logo.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
				[hostUtils.pathOnBoot('splash/balena-logo-default.png')]: Buffer.from(
					defaultLogo,
					'base64',
				),
			}).enable();

			// We pass something that is not a PNG
			await backend.setBootConfig({ image: 'aGVsbG8=' });

			// The file should NOT have changed
			expect(
				await fs.readFile(
					hostUtils.pathOnBoot('splash/balena-logo.png'),
					'base64',
				),
			).to.equal(defaultLogo);

			await tfs.restore();
		});
	});

	describe('isBootConfigVar', () => {
		it('Accepts any case variable names', () => {
			expect(backend.isBootConfigVar('HOST_SPLASH_IMAGE')).to.be.true;
			expect(backend.isBootConfigVar('HOST_SPLASH_image')).to.be.true;
			expect(backend.isBootConfigVar('HOST_SPLASH_Image')).to.be.true;
			expect(backend.isBootConfigVar('HOST_SPLASH_ImAgE')).to.be.true;
		});
	});
});
