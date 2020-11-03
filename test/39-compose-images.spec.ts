import * as _ from 'lodash';

import { docker } from '../src/lib/docker-utils';
import { expect } from './lib/chai-config';
import * as Images from '../src/compose/images';
import * as mockedDockerode from './lib/mocked-dockerode';
import * as mockedDatabase from './lib/mocked-database';
import * as db from '../src/db';
import * as sampleImageData from './data/compose-image-data.json';

describe('compose/images', () => {
	before(() => {
		mockedDatabase.create();
	});

	after(() => {
		try {
			mockedDatabase.restore();
		} catch (e) {
			/* noop */
		}
	});

	afterEach(() => {
		// Clear Dockerode actions recorded for each test
		mockedDockerode.resetHistory();
	});

	it('Removes a legacy Image', async () => {
		const images = sampleImageData['legacy-image'].dockerode;
		const IMAGE_TO_REMOVE = sampleImageData['legacy-image'].remove;
		const IMAGES_FROM_DB = sampleImageData['legacy-image'].database;
		// Stub the database to return images we want
		mockedDatabase.setImages(IMAGES_FROM_DB).stub();
		// Perform the test with our specially crafted data
		await mockedDockerode.testWithData({ images }, async () => {
			// Check that our legacy image exists
			await expect(docker.getImage(IMAGE_TO_REMOVE.name).inspect()).to
				.eventually.not.be.undefined;
			await expect(
				db.models('image').select().where(IMAGE_TO_REMOVE),
			).to.eventually.have.lengthOf(1);
			// Check that docker has this Image
			await expect(docker.getImage(IMAGE_TO_REMOVE.name).inspect()).to
				.eventually.not.be.undefined;
			// Now remove this image...
			await Images.remove(IMAGE_TO_REMOVE);
			// Check if it still exists!
			await expect(docker.getImage(IMAGE_TO_REMOVE.name).inspect()).to
				.eventually.be.undefined;
			await expect(db.models('image').select().where(IMAGE_TO_REMOVE)).to
				.eventually.be.empty;
			// Check that docker remove was called once
			const removeSteps = _(mockedDockerode.actions)
				.pickBy({ name: 'remove' })
				.map()
				.value();
			expect(removeSteps).to.have.lengthOf(1);
		});
	});

	it('Removes a single Image', async () => {
		const images = sampleImageData['single-image'].dockerode;
		const IMAGE_TO_REMOVE = sampleImageData['single-image'].remove;
		const IMAGES_FROM_DB = sampleImageData['single-image'].database;
		// Stub the database to return images we want
		mockedDatabase.setImages(IMAGES_FROM_DB).stub();
		// Perform the test with our specially crafted data
		await mockedDockerode.testWithData({ images }, async () => {
			// Check that a single image is returned when given entire object
			expect(
				db.models('image').select().where(IMAGE_TO_REMOVE),
			).to.eventually.have.lengthOf(1);
			// Check that only one image with this dockerImageId exists in the db
			expect(
				db
					.models('image')
					.where({ dockerImageId: IMAGE_TO_REMOVE.dockerImageId })
					.select(),
			).to.eventually.have.lengthOf(1);
			// Now remove this image...
			await Images.remove(IMAGE_TO_REMOVE);
			// Check that docker does not have this image
			await expect(docker.getImage(IMAGE_TO_REMOVE.name).inspect()).to
				.eventually.be.empty;
			// Check that the database longer has this image
			await expect(db.models('image').select().where(IMAGE_TO_REMOVE)).to
				.eventually.be.empty;
			// Check that docker remove was called once
			const removeSteps = _(mockedDockerode.actions)
				.pickBy({ name: 'remove' })
				.map()
				.value();
			expect(removeSteps).to.have.lengthOf(1);
		});
	});

	it('Removes an Image with digests', async () => {
		const images = sampleImageData['image-with-digests'].dockerode;
		const IMAGE_TO_REMOVE = sampleImageData['image-with-digests'].remove;
		const IMAGES_FROM_DB = sampleImageData['image-with-digests'].database;
		// Stub the database to return images we want
		mockedDatabase.setImages(IMAGES_FROM_DB).stub();
		// Perform the test with our specially crafted data
		await mockedDockerode.testWithData({ images }, async () => {
			// Check that a single image is returned when given entire object
			expect(
				db.models('image').select().where(IMAGE_TO_REMOVE),
			).to.eventually.have.lengthOf(1);
			// Check that multiple images with the same dockerImageId are returned
			expect(
				db
					.models('image')
					.where({ dockerImageId: IMAGE_TO_REMOVE.dockerImageId })
					.select(),
			).to.eventually.have.lengthOf(2);
			// Now remove these image...
			await Images.remove(IMAGE_TO_REMOVE);
			// Check that docker does not have this image
			await expect(docker.getImage(IMAGE_TO_REMOVE.name).inspect()).to
				.eventually.be.empty;
			// Check that the database no longer has this image
			await expect(db.models('image').select().where(IMAGE_TO_REMOVE)).to
				.eventually.be.empty;
			// Check that docker remove was called twice
			const removeSteps = _(mockedDockerode.actions)
				.pickBy({ name: 'remove' })
				.map()
				.value();
			expect(removeSteps).to.have.lengthOf(2);
		});
	});
});
