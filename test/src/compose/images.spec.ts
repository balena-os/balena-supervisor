import { expect } from 'chai';

import * as imageManager from '../../../src/compose/images';
import * as dbHelper from '../../lib/db-helper';
import { createImage, withMockerode } from '../../lib/mockerode';
import * as sinon from 'sinon';

import log from '../../../src/lib/supervisor-console';

describe('compose/images', () => {
	let testDb: dbHelper.TestDatabase;
	before(async () => {
		testDb = await dbHelper.createDB();

		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'event');
		sinon.stub(log, 'success');
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

	afterEach(() => {
		testDb.reset();
	});

	it('finds images by the dockerImageId in the database if looking by name does not succeed', async () => {
		const dbImage = {
			id: 246,
			name:
				'registry2.balena-cloud.com/v2/793f9296017bbfe026334820ab56bb3a@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			appId: 1658654,
			serviceId: 650325,
			serviceName: 'app_1',
			imageId: 2693229,
			releaseId: 1524186,
			dependent: 0,
			dockerImageId:
				'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
		};
		await testDb.models('image').insert([dbImage]);

		const images = [
			createImage(
				{
					Id:
						'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
					Config: {
						Labels: {
							'io.balena.some-label': 'this is my label',
						},
					},
				},
				{
					References: [
						// Delta digest doesn't match image.name digest
						'registry2.balena-cloud.com/v2/793f9296017bbfe026334820ab56bb3a:delta-ada9fbb57d90e61e:@sha256:12345a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					],
				},
			),
		];

		await withMockerode(
			async (mockerode) => {
				// Looking by name should fail, if not, this is a mockerode issue
				await expect(mockerode.getImage(dbImage.name).inspect()).to.be.rejected;

				// Looking up the image by id should succeed
				await expect(mockerode.getImage(dbImage.dockerImageId).inspect()).to.not
					.be.rejected;

				const img = await imageManager.inspectByName(dbImage.name);

				expect(mockerode.getImage).to.have.been.calledWith(
					'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
				);

				// Check that the found image has the proper labels
				expect(img.Config.Labels).to.deep.equal({
					'io.balena.some-label': 'this is my label',
				});
			},
			{ images },
		);
	});

	it('removes a single legacy db images without dockerImageId', async () => {
		// Legacy images don't have a dockerImageId so they are queried by name
		const imageToRemove = {
			id: 246,
			name:
				'registry2.balena-cloud.com/v2/793f9296017bbfe026334820ab56bb3a@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			appId: 1658654,
			serviceId: 650325,
			serviceName: 'app_1',
			imageId: 2693229,
			releaseId: 1524186,
			dependent: 0,
		};

		await testDb.models('image').insert([imageToRemove]);

		// Engine image state
		const images = [
			createImage(
				{
					Id: 'deadbeef',
				},
				{
					// Image references
					References: [
						'registry2.balena-cloud.com/v2/793f9296017bbfe026334820ab56bb3a:delta-ada9fbb57d90e61e@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					],
				},
			),
			createImage(
				{
					Id: 'deadca1f',
				},
				{
					References: ['balena/aarch64-supervisor:11.11.11'],
				},
			),
		];

		// Perform the test with our specially crafted data
		await withMockerode(
			async (mockerode) => {
				// Check that our legacy image exists
				// failsafe to check for mockerode problems
				await expect(
					mockerode.getImage(imageToRemove.name).inspect(),
					'image exists on the engine before test',
				).to.not.be.rejected;

				// Check that the image exists on the db
				expect(
					await testDb.models('image').select().where(imageToRemove),
				).to.have.lengthOf(1);

				// Now remove this image...
				await imageManager.remove(imageToRemove);

				// This checks that the remove method was ultimately called
				expect(mockerode.removeImage).to.have.been.calledOnceWith(
					imageToRemove.name,
				);

				// Check that the image was removed from the db
				expect(await testDb.models('image').select().where(imageToRemove)).to.be
					.empty;
			},
			{ images },
		);
	});

	it('removes image from DB and engine when there is a single DB image with matching dockerImageId', async () => {
		// Newer image
		const imageToRemove = {
			id: 246,
			name:
				'registry2.balena-cloud.com/v2/793f9296017bbfe026334820ab56bb3a@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			appId: 1658654,
			serviceId: 650325,
			serviceName: 'app_1',
			imageId: 2693229,
			releaseId: 1524186,
			dependent: 0,
			dockerImageId:
				'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
		};

		// Insert images into the db
		await testDb.models('image').insert([
			imageToRemove,
			{
				id: 247,
				name:
					'registry2.balena-cloud.com/v2/902cf44eb0ed51675a0bf95a7bbf0c91@sha256:12345a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
				appId: 1658654,
				serviceId: 650331,
				serviceName: 'app_2',
				imageId: 2693230,
				releaseId: 1524186,
				dependent: 0,
				dockerImageId:
					'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc901234',
			},
		]);

		// Engine image state
		const images = [
			// The image to remove
			createImage(
				{
					Id:
						'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
				},
				{
					// The target digest matches the image name
					References: [
						'registry2.balena-cloud.com/v2/793f9296017bbfe026334820ab56bb3a:delta-ada9fbb57d90e61e@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					],
				},
			),
			// Other images to test
			createImage(
				{
					Id: 'aaa',
				},
				{
					References: ['balena/aarch64-supervisor:11.11.11'],
				},
			),
			// The other image on the database
			createImage(
				{
					Id:
						'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc901234',
				},
				{
					References: [
						'registry2.balena-cloud.com/v2/902cf44eb0ed51675a0bf95a7bbf0c91:delta-80ed841a1d3fefa9@sha256:12345a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					],
				},
			),
		];

		// Perform the test with our specially crafted data
		await withMockerode(
			async (mockerode) => {
				// Check that the image exists
				// this is really checking that mockerode works ok
				await expect(
					mockerode.getImage(imageToRemove.name).inspect(),
					'image exists on the engine before test',
				).to.not.be.rejected;

				// Check that only one image with this dockerImageId exists in the db
				// in memory db is a bit flaky sometimes, this checks for issues
				expect(
					await testDb.models('image').where(imageToRemove).select(),
					'image exists on db before the test',
				).to.have.lengthOf(1);

				// Check that only one image with this dockerImageId exists in the db
				expect(
					await testDb
						.models('image')
						.where({ dockerImageId: imageToRemove.dockerImageId })
						.select(),
				).to.have.lengthOf(1);

				// Now remove this image...
				await imageManager.remove(imageToRemove);

				// Check that the remove method was only called once
				expect(mockerode.removeImage).to.have.been.calledOnceWith(
					imageToRemove.dockerImageId,
				);

				// Check that the database no longer has this image
				expect(await testDb.models('image').select().where(imageToRemove)).to.be
					.empty;

				// Expect 1 entry left on the database
				expect(await testDb.models('image').select()).to.have.lengthOf(1);
			},
			{ images },
		);
	});

	it('removes image from DB by name where there are multiple db images with same docker id', async () => {
		const imageToRemove = {
			id: 246,
			name:
				'registry2.balena-cloud.com/v2/793f9296017bbfe026334820ab56bb3a@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			appId: 1658654,
			serviceId: 650325,
			serviceName: 'app_1',
			imageId: 2693229,
			releaseId: 1524186,
			dependent: 0,
			dockerImageId:
				'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
		};

		const imageWithSameDockerImageId = {
			id: 247,
			name:
				'registry2.balena-cloud.com/v2/902cf44eb0ed51675a0bf95a7bbf0c91@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			appId: 1658654,
			serviceId: 650331,
			serviceName: 'app_2',
			imageId: 2693230,
			releaseId: 1524186,
			dependent: 0,

			// Same imageId
			dockerImageId: imageToRemove.dockerImageId,
		};

		// Insert images into the db
		await testDb.models('image').insert([
			imageToRemove,
			// Another image from the same app
			imageWithSameDockerImageId,
		]);

		// Engine image state
		const images = [
			// The image to remove
			createImage(
				{
					Id: imageToRemove.dockerImageId,
				},
				{
					References: [imageToRemove.name, imageWithSameDockerImageId.name],
				},
			),
			// Other images to test
			createImage(
				{
					Id: 'aaa',
				},
				{
					References: ['balena/aarch64-supervisor:11.11.11'],
				},
			),
		];

		// Perform the test with our specially crafted data
		await withMockerode(
			async (mockerode) => {
				// Check that the image is on the engine
				// really checking mockerode behavior
				await expect(
					mockerode.getImage(imageToRemove.dockerImageId).inspect(),
					'image exists on the engine before the test',
				).to.not.be.rejected;

				// Check that multiple images with the same dockerImageId are returned
				expect(
					await testDb
						.models('image')
						.where({ dockerImageId: imageToRemove.dockerImageId })
						.select(),
				).to.have.lengthOf(2);

				// Now remove these images
				await imageManager.remove(imageToRemove);

				// Check that only the image with the right name was removed
				expect(mockerode.removeImage).to.have.been.calledOnceWith(
					imageToRemove.name,
				);

				// Check that the database no longer has this image
				expect(await testDb.models('image').select().where(imageToRemove)).to.be
					.empty;

				// Check that the image with the same dockerImageId is still on the database
				expect(
					await testDb
						.models('image')
						.select()
						.where({ dockerImageId: imageWithSameDockerImageId.dockerImageId }),
				).to.have.lengthOf(1);
			},
			{ images },
		);
	});

	it('removes image from DB by tag where there are multiple db images with same docker id and deltas are being used', async () => {
		const imageToRemove = {
			id: 246,
			name:
				'registry2.balena-cloud.com/v2/aaaa@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			appId: 1658654,
			serviceId: 650325,
			serviceName: 'app_1',
			imageId: 2693229,
			releaseId: 1524186,
			dependent: 0,
			dockerImageId: 'sha256:deadbeef',
		};

		const imageWithSameDockerImageId = {
			id: 247,
			name:
				'registry2.balena-cloud.com/v2/bbbb@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			appId: 1658654,
			serviceId: 650331,
			serviceName: 'app_2',
			imageId: 2693230,
			releaseId: 1524186,
			dependent: 0,
			dockerImageId: imageToRemove.dockerImageId,
		};

		// Insert images into the db
		await testDb.models('image').insert([
			imageToRemove,
			// Another image from the same app
			imageWithSameDockerImageId,
		]);

		// Engine image state
		const images = [
			// The image to remove
			createImage(
				{
					Id: imageToRemove.dockerImageId,
				},
				{
					References: [
						// The image has two deltas with different digests than those in image.name
						'registry2.balena-cloud.com/v2/aaaa:delta-123@sha256:6eb712fc797ff68f258d9032cf292c266cb9bd8be4cbdaaafeb5a8824bb104fd',
						'registry2.balena-cloud.com/v2/bbbb:delta-456@sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc901234',
					],
				},
			),
		];

		// Perform the test with our specially crafted data
		await withMockerode(
			async (mockerode) => {
				// Check that the image is on the engine
				await expect(
					mockerode.getImage(imageToRemove.dockerImageId).inspect(),
					'image can be found by id before the test',
				).to.not.be.rejected;

				// Check that a single image is returned when given entire object
				expect(
					await testDb.models('image').select().where(imageToRemove),
				).to.have.lengthOf(1);

				// Check that multiple images with the same dockerImageId are returned
				expect(
					await testDb
						.models('image')
						.where({ dockerImageId: imageToRemove.dockerImageId })
						.select(),
				).to.have.lengthOf(2);

				// Now remove these images
				await imageManager.remove(imageToRemove);

				// This tests the behavior
				expect(mockerode.removeImage).to.have.been.calledOnceWith(
					'registry2.balena-cloud.com/v2/aaaa:delta-123',
				);

				// Check that the database no longer has this image
				expect(await testDb.models('image').select().where(imageToRemove)).to.be
					.empty;

				// Check that the image with the same dockerImageId is still on the database
				expect(
					await testDb
						.models('image')
						.select()
						.where(imageWithSameDockerImageId),
				).to.have.lengthOf(1);
			},
			{ images },
		);
	});
});
