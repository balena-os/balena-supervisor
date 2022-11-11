import { expect } from 'chai';

import * as imageManager from '~/src/compose/images';
import { createImage, withMockerode } from '~/test-lib/mockerode';
import { cleanupDocker, createDockerImage } from '~/test-lib/docker-helper';

import * as Docker from 'dockerode';
import * as db from '~/src/db';

// TODO: this code is duplicated in multiple tests
// create a test module with all helper functions like this
function createDBImage(
	{
		appId = 1,
		name = 'test-image',
		serviceName = 'test',
		dependent = 0,
		...extra
	} = {} as Partial<imageManager.Image>,
) {
	return {
		appId,
		dependent,
		name,
		serviceName,
		...extra,
	} as imageManager.Image;
}

describe('compose/images', () => {
	const docker = new Docker();
	before(async () => {
		await db.initialized();
	});

	afterEach(async () => {
		await db.models('image').del();
	});

	after(async () => {
		await cleanupDocker({ docker });
	});

	it('finds image by matching digest on the database', async () => {
		const dbImage = createDBImage({
			name: 'registry2.balena-cloud.com/v2/aaaaa@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			dockerImageId:
				'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
		});
		await db.models('image').insert([dbImage]);

		const images = [
			createImage(
				{
					Id: 'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
				},
				{
					References: [
						// Different image repo
						'registry2.balena-cloud.com/v2/bbbb@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					],
				},
			),
		];

		// INFO: We use mockerode here because cannot create images with a specific digest on the engine
		// but we need to be able to test looking images by digest
		await withMockerode(
			async (mockerode) => {
				// Looking by name should fail, if not, this is a mockerode issue
				await expect(mockerode.getImage(dbImage.name).inspect()).to.be.rejected;

				// Looking up the image by id should succeed
				await expect(mockerode.getImage(dbImage.dockerImageId!).inspect()).to
					.not.be.rejected;

				// The image is found
				expect(await imageManager.inspectByName(dbImage.name))
					.to.have.property('Id')
					.that.equals(
						'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
					);

				// It couldn't find the image by name so it finds it by matching digest
				expect(mockerode.getImage).to.have.been.calledWith(
					'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
				);
			},
			{ images },
		);
	});

	it('finds image by tag on the engine', async () => {
		const dockerImageId = await createDockerImage(
			'some-image:some-tag',
			['io.balena.testing=1'],
			docker,
		);

		expect(await imageManager.inspectByName('some-image:some-tag'))
			.to.have.property('Id')
			.that.equals(dockerImageId);

		await expect(
			imageManager.inspectByName('non-existing-image:non-existing-tag'),
		).to.be.rejected;

		await docker.getImage('some-image:some-tag').remove();
	});

	it('finds image by reference on the engine', async () => {
		const images = [
			createImage(
				{
					Id: 'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
				},
				{
					References: [
						// the reference we expect to look for is registry2.balena-cloud.com/v2/one
						'registry2.balena-cloud.com/v2/one:delta-one@sha256:12345a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
						'registry2.balena-cloud.com/v2/one:latest@sha256:12345a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					],
				},
			),
		];

		// INFO: we cannot create specific references to test on the engine, we need to
		// use mockerode instead.
		// QUESTION: Maybe the image search is overspecified and we should find a
		// common identifier for all image search (e.g. label?)
		await withMockerode(
			async (mockerode) => {
				// This is really testing mockerode functionality
				expect(
					await mockerode.listImages({
						filters: {
							reference: ['registry2.balena-cloud.com/v2/one'],
						},
					}),
				).to.have.lengthOf(1);

				expect(
					await imageManager.inspectByName(
						// different target digest but same imageName
						'registry2.balena-cloud.com/v2/one@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					),
				)
					.to.have.property('Id')
					.that.equals(
						'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
					);

				expect(mockerode.getImage).to.have.been.calledWith(
					'sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc90e8e7',
				);

				// Looking for the reference with correct name tag shoud not throw
				await expect(
					imageManager.inspectByName(
						// different target digest but same tag
						'registry2.balena-cloud.com/v2/one:delta-one@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					),
				).to.not.be.rejected;

				// Looking for a non existing reference should throw
				await expect(
					imageManager.inspectByName(
						'registry2.balena-cloud.com/v2/two@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					),
				).to.be.rejected;
				await expect(
					imageManager.inspectByName(
						'registry2.balena-cloud.com/v2/one:some-tag@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
					),
				).to.be.rejected;
			},
			{ images },
		);
	});

	it('returns all images in both the database and the engine', async () => {
		await db.models('image').insert([
			createDBImage({
				name: 'first-image-name:first-image-tag',
				serviceName: 'app_1',
				dockerImageId: 'sha256:first-image-id',
			}),
			createDBImage({
				name: 'second-image-name:second-image-tag',
				serviceName: 'app_2',
				dockerImageId: 'sha256:second-image-id',
			}),
			createDBImage({
				name: 'registry2.balena-cloud.com/v2/three@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf558',
				serviceName: 'app_3',
				// Third image has different name but same docker id
				dockerImageId: 'sha256:second-image-id',
			}),
			createDBImage({
				name: 'fourth-image-name:fourth-image-tag',
				serviceName: 'app_4',
				// The fourth image exists on the engine but with the wrong id
				dockerImageId: 'sha256:fourth-image-id',
			}),
		]);

		const images = [
			createImage(
				{
					Id: 'sha256:first-image-id',
				},
				{
					References: ['first-image-name:first-image-tag'],
				},
			),
			createImage(
				{
					Id: 'sha256:second-image-id',
				},
				{
					References: [
						// The tag for the second image does not exist on the engine but it should be found
						'not-second-image-name:some-image-tag',
						'fourth-image-name:fourth-image-tag',
						'registry2.balena-cloud.com/v2/three@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf558',
					],
				},
			),
		];

		// Perform the test with our specially crafted data
		await withMockerode(
			async (mockerode) => {
				// failsafe to check for mockerode problems
				expect(
					await mockerode.listImages(),
					'images exist on the engine before test',
				).to.have.lengthOf(2);

				const availableImages = await imageManager.getAvailable();
				expect(availableImages).to.have.lengthOf(4);
			},
			{ images },
		);
	});

	it('removes a single legacy db images without dockerImageId', async () => {
		await createDockerImage(
			'image-name:image-tag',
			['io.balena.testing=1'],
			docker,
		);

		// Legacy images don't have a dockerImageId so they are queried by name
		const imageToRemove = createDBImage({
			name: 'image-name:image-tag',
		});

		await db.models('image').insert([imageToRemove]);

		// Check that our legacy image exists
		// failsafe to check for mockerode problems
		await expect(
			docker.getImage(imageToRemove.name).inspect(),
			'image exists on the engine before test',
		).to.not.be.rejected;

		// Check that the image exists on the db
		expect(
			await db.models('image').select().where(imageToRemove),
		).to.have.lengthOf(1);

		// Now remove this image...
		await imageManager.remove(imageToRemove);

		// Check that the image was removed from the db
		expect(await db.models('image').select().where(imageToRemove)).to.be.empty;
	});

	it('removes image from DB and engine when there is a single DB image with matching name', async () => {
		// Newer image
		const imageToRemove = createDBImage({
			name: 'registry2.balena-cloud.com/v2/one@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			dockerImageId: 'sha256:image-id-one',
		});

		// Insert images into the db
		await db.models('image').insert([
			imageToRemove,
			createDBImage({
				name: 'registry2.balena-cloud.com/v2/two@sha256:12345a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
				dockerImageId: 'sha256:image-id-two',
			}),
		]);

		// Engine image state
		const images = [
			// The image to remove
			createImage(
				{
					Id: 'sha256:image-id-one',
				},
				{
					References: [
						'registry2.balena-cloud.com/v2/one:delta-one@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
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
					Id: 'sha256:image-id-two',
				},
				{
					References: [
						'registry2.balena-cloud.com/v2/two:delta-two@sha256:12345a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
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
					await db.models('image').where(imageToRemove).select(),
					'image exists on db before the test',
				).to.have.lengthOf(1);

				// Now remove this image...
				await imageManager.remove(imageToRemove);

				// Check that the remove method was only called once
				expect(mockerode.removeImage).to.have.been.calledOnceWith(
					'registry2.balena-cloud.com/v2/one:delta-one',
				);

				// Check that the database no longer has this image
				expect(await db.models('image').select().where(imageToRemove)).to.be
					.empty;

				// Expect 1 entry left on the database
				expect(await db.models('image').select()).to.have.lengthOf(1);
			},
			{ images },
		);
	});

	it('removes the requested image even when there are multiple DB images with same docker ID', async () => {
		const dockerImageId = await createDockerImage(
			'registry2.balena-cloud.com/v2/one',
			['io.balena.testing=1'],
			docker,
		);

		const imageToRemove = createDBImage({
			name: 'registry2.balena-cloud.com/v2/one',
			dockerImageId,
		});

		const imageWithSameDockerImageId = createDBImage({
			name: 'registry2.balena-cloud.com/v2/two@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			// Same imageId
			dockerImageId,
		});

		// Insert images into the db
		await db.models('image').insert([
			imageToRemove,
			// Another image from the same app
			imageWithSameDockerImageId,
		]);

		// Check that multiple images with the same dockerImageId are returned
		expect(
			await db
				.models('image')
				.where({ dockerImageId: imageToRemove.dockerImageId })
				.select(),
		).to.have.lengthOf(2);

		// Now remove these images
		await imageManager.remove(imageToRemove);

		// Check that the database no longer has this image
		expect(await db.models('image').select().where(imageToRemove)).to.be.empty;

		// Check that the image with the same dockerImageId is still on the database
		expect(
			await db
				.models('image')
				.select()
				.where({ dockerImageId: imageWithSameDockerImageId.dockerImageId }),
		).to.have.lengthOf(1);
	});

	it('removes image from DB by tag when deltas are being used', async () => {
		const imageToRemove = createDBImage({
			name: 'registry2.balena-cloud.com/v2/one@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			dockerImageId: 'sha256:image-one-id',
		});

		const imageWithSameDockerImageId = createDBImage({
			name: 'registry2.balena-cloud.com/v2/two@sha256:2c969a1ba1c6bc10df53481f48c6a74dbd562cfb41ba58f81beabd03facf5582',
			// Same docker id
			dockerImageId: 'sha256:image-one-id',
		});

		// Insert images into the db
		await db.models('image').insert([
			imageToRemove,
			// Another image from the same app
			imageWithSameDockerImageId,
		]);

		// Engine image state
		const images = [
			// The image to remove
			createImage(
				{
					Id: imageToRemove.dockerImageId!,
				},
				{
					References: [
						// The image has two deltas with different digests than those in image.name
						'registry2.balena-cloud.com/v2/one:delta-one@sha256:6eb712fc797ff68f258d9032cf292c266cb9bd8be4cbdaaafeb5a8824bb104fd',
						'registry2.balena-cloud.com/v2/two:delta-two@sha256:f1154d76c731f04711e5856b6e6858730e3023d9113124900ac65c2ccc901234',
					],
				},
			),
		];

		// Perform the test with our specially crafted data
		await withMockerode(
			async (mockerode) => {
				// Check that the image is on the engine
				await expect(
					mockerode.getImage(imageToRemove.dockerImageId!).inspect(),
					'image can be found by id before the test',
				).to.not.be.rejected;

				// Check that a single image is returned when given entire object
				expect(
					await db.models('image').select().where(imageToRemove),
				).to.have.lengthOf(1);

				// Check that multiple images with the same dockerImageId are returned
				expect(
					await db
						.models('image')
						.where({ dockerImageId: imageToRemove.dockerImageId })
						.select(),
				).to.have.lengthOf(2);

				// Now remove these images
				await imageManager.remove(imageToRemove);

				// This tests the behavior
				expect(mockerode.removeImage).to.have.been.calledOnceWith(
					'registry2.balena-cloud.com/v2/one:delta-one',
				);

				// Check that the database no longer has this image
				expect(await db.models('image').select().where(imageToRemove)).to.be
					.empty;

				// Check that the image with the same dockerImageId is still on the database
				expect(
					await db.models('image').select().where(imageWithSameDockerImageId),
				).to.have.lengthOf(1);
			},
			{ images },
		);
	});
});
