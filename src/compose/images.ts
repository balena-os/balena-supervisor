import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import { EventEmitter } from 'events';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';

import Database from '../db';
import * as constants from '../lib/constants';
import {
	DeltaFetchOptions,
	DockerUtils,
	FetchOptions,
} from '../lib/docker-utils';
import { DeltaStillProcessingError, NotFoundError } from '../lib/errors';
import * as LogTypes from '../lib/log-types';
import * as validation from '../lib/validation';
import Logger from '../logger';

interface ImageEvents {
	change: void;
}

type ImageEventEmitter = StrictEventEmitter<EventEmitter, ImageEvents>;

interface ImageConstructOpts {
	docker: DockerUtils;
	logger: Logger;
	db: Database;
}

interface FetchProgressEvent {
	percentage: number;
}

export interface Image {
	id: number;
	// image registry/repo@digest or registry/repo:tag
	name: string;
	appId: number;
	serviceId: number;
	serviceName: string;
	// Id from balena api
	imageId: number;
	releaseId: number;
	dependent: number;
	dockerImageId: string;
	status: 'Downloading' | 'Downloaded' | 'Deleting';
	downloadProgress: Nullable<number>;
}

// TODO: This is necessary for the format() method, but I'm not sure
// why, and it seems like a bad idea as it is. Fix the need for this.
type MaybeImage = { [key in keyof Image]: Image[key] | null };

// TODO: Remove the need for this type...
type NormalisedDockerImage = Docker.ImageInfo & {
	NormalisedRepoTags: string[];
};

export class Images extends (EventEmitter as {
	new (): ImageEventEmitter;
}) {
	private docker: DockerUtils;
	private logger: Logger;
	private db: Database;

	private imageCleanupFailures: Dictionary<number> = {};
	// A store of volatile state for images (e.g. download progress), indexed by imageId
	private volatileState: { [imageId: number]: Image } = {};

	public constructor(opts: ImageConstructOpts) {
		super();

		this.docker = opts.docker;
		this.logger = opts.logger;
		this.db = opts.db;
	}

	public async triggerFetch(
		image: Image,
		opts: FetchOptions,
		onFinish = _.noop,
	): Promise<null> {
		const onProgress = (progress: FetchProgressEvent) => {
			// Only report the percentage if we haven't finished fetching
			if (this.volatileState[image.imageId] != null) {
				this.reportChange(image.imageId, {
					downloadProgress: progress.percentage,
				});
			}
		};

		let success: boolean;
		try {
			const imageName = await this.normalise(image.name);
			image = _.clone(image);
			image.name = imageName;

			await this.markAsSupervised(image);

			const img = await this.inspectByName(image.name);
			await this.db
				.models('image')
				.update({ dockerImageId: img.Id })
				.where(image);

			onFinish(true);
			return null;
		} catch (e) {
			if (!NotFoundError(e)) {
				throw e;
			}
			this.reportChange(
				image.imageId,
				_.merge(_.clone(image), { status: 'Downloading', downloadProgress: 0 }),
			);

			try {
				let id;
				if (opts.delta && (opts as DeltaFetchOptions).deltaSource != null) {
					id = await this.fetchDelta(image, opts, onProgress);
				} else {
					id = await this.fetchImage(image, opts, onProgress);
				}

				await this.db
					.models('image')
					.update({ dockerImageId: id })
					.where(image);

				this.logger.logSystemEvent(LogTypes.downloadImageSuccess, { image });
				success = true;
			} catch (err) {
				if (err instanceof DeltaStillProcessingError) {
					// If this is a delta image pull, and the delta still hasn't finished generating,
					// don't show a failure message, and instead just inform the user that it's remotely
					// processing
					this.logger.logSystemEvent(LogTypes.deltaStillProcessingError, {});
				} else {
					this.logger.logSystemEvent(LogTypes.downloadImageError, {
						image,
						error: err,
					});
				}
				success = false;
			}
		}

		this.reportChange(image.imageId);
		onFinish(success);
		return null;
	}

	public async remove(image: Image): Promise<void> {
		try {
			await this.removeImageIfNotNeeded(image);
		} catch (e) {
			this.logger.logSystemEvent(LogTypes.deleteImageError, {
				image,
				error: e,
			});
			throw e;
		}
	}

	public async getByDockerId(id: string): Promise<Image> {
		return await this.db
			.models('image')
			.where({ dockerImageId: id })
			.first();
	}

	public async removeByDockerId(id: string): Promise<void> {
		const image = await this.getByDockerId(id);
		await this.remove(image);
	}

	private async getNormalisedTags(image: Docker.ImageInfo): Promise<string[]> {
		return await Bluebird.map(
			image.RepoTags != null ? image.RepoTags : [],
			this.normalise.bind(this),
		);
	}

	private withImagesFromDockerAndDB<T>(
		cb: (dockerImages: NormalisedDockerImage[], composeImages: Image[]) => T,
	) {
		return Bluebird.join(
			Bluebird.resolve(this.docker.listImages({ digests: true })).map(image => {
				const newImage: Dictionary<unknown> = _.clone(image);
				newImage.NormalisedRepoTags = this.getNormalisedTags(image);
				return Bluebird.props(newImage);
			}),
			this.db.models('image').select(),
			cb,
		);
	}

	private matchesTagOrDigest(
		image: Image,
		dockerImage: NormalisedDockerImage,
	): boolean {
		return (
			_.includes(dockerImage.NormalisedRepoTags, image.name) ||
			_.some(dockerImage.RepoDigests, digest =>
				Images.hasSameDigest(image.name, digest),
			)
		);
	}

	private isAvailableInDocker(
		image: Image,
		dockerImages: NormalisedDockerImage[],
	): boolean {
		return _.some(
			dockerImages,
			dockerImage =>
				this.matchesTagOrDigest(image, dockerImage) ||
				image.dockerImageId === dockerImage.Id,
		);
	}

	public async getAvailable(_localMode: boolean): Promise<Image[]> {
		const images = await this.withImagesFromDockerAndDB(
			(dockerImages, supervisedImages) =>
				_.filter(supervisedImages, image =>
					this.isAvailableInDocker(image, dockerImages),
				),
		);

		return images;
	}

	// TODO: Why does this need a Bluebird.try?
	public getDownloadingImageIds() {
		return Bluebird.try(() =>
			_(this.volatileState)
				.pickBy({ status: 'Downloading' })
				.keys()
				.map(validation.checkInt)
				.value(),
		);
	}

	public async cleanupDatabase(): Promise<void> {
		const imagesToRemove = await this.withImagesFromDockerAndDB(
			async (dockerImages, supervisedImages) => {
				for (const supervisedImage of supervisedImages) {
					// If the supervisor was interrupted between fetching an image and storing its id,
					// some entries in the db might need to have the dockerImageId populated
					if (supervisedImage.dockerImageId == null) {
						const id = _.get(
							_.find(dockerImages, dockerImage =>
								this.matchesTagOrDigest(supervisedImage, dockerImage),
							),
							'Id',
						);

						if (id != null) {
							await this.db
								.models('image')
								.update({ dockerImageId: id })
								.where(supervisedImage);
							supervisedImage.dockerImageId = id;
						}
					}
				}
				return _.reject(supervisedImages, image =>
					this.isAvailableInDocker(image, dockerImages),
				);
			},
		);

		const ids = _.map(imagesToRemove, 'id');
		await this.db
			.models('image')
			.del()
			.whereIn('id', ids);
	}

	public async getStatus(localMode: boolean) {
		const images = await this.getAvailable(localMode);
		for (const image of images) {
			image.status = 'Downloaded';
			image.downloadProgress = null;
		}
		const status = _.clone(this.volatileState);
		for (const image of images) {
			if (status[image.imageId] == null) {
				status[image.imageId] = image;
			}
		}
		return _.values(status);
	}

	public async update(image: Image): Promise<void> {
		image = this.format(image);
		await this.db
			.models('image')
			.update(image)
			.where({ name: image.name });
	}

	public async save(image: Image): Promise<void> {
		const img = await this.inspectByName(image.name);
		image = _.clone(image);
		image.dockerImageId = img.Id;
		await this.markAsSupervised(image);
	}

	private async getImagesForCleanup(): Promise<string[]> {
		const images = [];

		const [
			supervisorImageInfo,
			supervisorImage,
			usedImageIds,
		] = await Promise.all([
			this.docker.getRegistryAndName(constants.supervisorImage),
			this.docker.getImage(constants.supervisorImage).inspect(),
			this.db
				.models('image')
				.select('dockerImageId')
				.map((img: Image) => img.dockerImageId),
		]);

		const supervisorRepos = [supervisorImageInfo.imageName];
		// If we're on the new balena/ARCH-supervisor image
		if (_.startsWith(supervisorImageInfo.imageName, 'balena/')) {
			supervisorRepos.push(
				supervisorImageInfo.imageName.replace(/^balena/, 'resin'),
			);
		}

		const isSupervisorRepoTag = ({
			imageName,
			tagName,
		}: {
			imageName: string;
			tagName: string;
		}) => {
			return (
				_.some(supervisorRepos, repo => imageName === repo) &&
				tagName !== supervisorImageInfo.tagName
			);
		};

		const dockerImages = await this.docker.listImages({ digests: true });
		for (const image of dockerImages) {
			// Cleanup should remove truly dangling images (i.e dangling and with no digests)
			if (Images.isDangling(image) && !_.includes(usedImageIds, image.Id)) {
				images.push(image.Id);
			} else if (
				!_.isEmpty(image.RepoTags) &&
				image.Id !== supervisorImage.Id
			) {
				// We also remove images from the supervisor repository with a different tag
				for (const tag of image.RepoTags) {
					const imageNameComponents = await this.docker.getRegistryAndName(tag);
					if (isSupervisorRepoTag(imageNameComponents)) {
						images.push(image.Id);
					}
				}
			}
		}

		return _(images)
			.uniq()
			.filter(
				image =>
					this.imageCleanupFailures[image] == null ||
					Date.now() - this.imageCleanupFailures[image] >
						constants.imageCleanupErrorIgnoreTimeout,
			)
			.value();
	}

	public async inspectByName(
		imageName: string,
	): Promise<Docker.ImageInspectInfo> {
		try {
			return await this.docker.getImage(imageName).inspect();
		} catch (e) {
			if (NotFoundError(e)) {
				const digest = imageName.split('@')[1];
				let imagesFromDb: Image[];
				if (digest != null) {
					imagesFromDb = await this.db
						.models('image')
						.where('name', 'like', `%@${digest}`);
				} else {
					imagesFromDb = await this.db
						.models('image')
						.where({ name: imageName })
						.select();
				}

				for (const image of imagesFromDb) {
					if (image.dockerImageId != null) {
						return await this.docker.getImage(image.dockerImageId).inspect();
					}
				}
			}
			throw e;
		}
	}

	public async isCleanupNeeded() {
		return !_.isEmpty(await this.getImagesForCleanup());
	}

	public async cleanup() {
		const images = await this.getImagesForCleanup();
		for (const image of images) {
			console.log(`Cleaning up ${image}`);
			try {
				await this.docker.getImage(image).remove({ force: true });
				delete this.imageCleanupFailures[image];
			} catch (e) {
				this.logger.logSystemMessage(
					`Error cleaning up ${image}: ${e.message} - will ignore for 1 hour`,
					{ error: e },
					'Image cleanup error',
				);
				this.imageCleanupFailures[image] = Date.now();
			}
		}
	}

	public static isSameImage(image1: Image, image2: Image): boolean {
		return (
			image1.name === image2.name ||
			Images.hasSameDigest(image1.name, image2.name)
		);
	}

	private normalise(imageName: string): Bluebird<string> {
		return this.docker.normaliseImageName(imageName);
	}

	private static isDangling(image: Docker.ImageInfo): boolean {
		return (
			(_.isEmpty(image.RepoTags) ||
				_.isEqual(image.RepoTags, ['<none>:<none>'])) &&
			(_.isEmpty(image.RepoDigests) ||
				_.isEqual(image.RepoDigests, ['<none>@<none>']))
		);
	}

	private static hasSameDigest(
		name1: Nullable<string>,
		name2: Nullable<string>,
	): boolean {
		const hash1 = name1 != null ? name1.split('@')[1] : null;
		const hash2 = name2 != null ? name2.split('@')[1] : null;
		return hash1 != null && hash1 === hash2;
	}

	private async removeImageIfNotNeeded(image: Image): Promise<void> {
		let removed: boolean;

		// We first fetch the image from the DB to ensure it exists,
		// and get the dockerImageId and any other missing fields
		const images = await this.db
			.models('image')
			.select()
			.where(image);

		if (images.length === 0) {
			removed = false;
		}

		const img = images[0];
		try {
			if (img.dockerImageId == null) {
				// Legacy image from before we started using dockerImageId, so we try to remove it
				// by name
				await this.docker.getImage(img.name).remove({ force: true });
				removed = true;
			} else {
				const imagesFromDb = await this.db
					.models('image')
					.where({ dockerImageId: img.dockerImageId })
					.select();
				if (
					imagesFromDb.length === 1 &&
					_.isEqual(this.format(imagesFromDb[0]), this.format(img))
				) {
					this.reportChange(
						image.imageId,
						_.merge(_.clone(image), { status: 'Deleting' }),
					);
					this.logger.logSystemEvent(LogTypes.deleteImage, { image });
					this.docker.getImage(img.dockerImageId).remove({ force: true });
					removed = true;
				} else if (!Images.hasDigest(img.name)) {
					// Image has a regular tag, so we might have to remove unnecessary tags
					const dockerImage = await this.docker
						.getImage(img.dockerImageId)
						.inspect();
					const differentTags = _.reject(imagesFromDb, { name: img.name });

					if (
						dockerImage.RepoTags.length > 1 &&
						_.includes(dockerImage.RepoTags, img.name) &&
						_.some(dockerImage.RepoTags, t =>
							_.some(differentTags, { name: t }),
						)
					) {
						await this.docker.getImage(img.name).remove({ noprune: true });
					}
					removed = false;
				} else {
					removed = false;
				}
			}
		} catch (e) {
			if (NotFoundError(e)) {
				removed = false;
			} else {
				throw e;
			}
		} finally {
			this.reportChange(image.imageId);
		}

		await this.db
			.models('image')
			.del()
			.where({ id: img.id });

		if (removed) {
			this.logger.logSystemEvent(LogTypes.deleteImageSuccess, { image });
		}
	}

	private async markAsSupervised(image: Image): Promise<void> {
		image = this.format(image);
		await this.db.upsertModel('image', image, image);
	}

	private format(image: MaybeImage): Image {
		return _(image)
			.defaults({
				serviceId: null,
				serviceName: null,
				imageId: null,
				releaseId: null,
				dependent: 0,
				dockerImageId: null,
			})
			.omit('id')
			.value() as Image;
	}

	private async fetchDelta(
		image: Image,
		opts: FetchOptions,
		onProgress: (evt: FetchProgressEvent) => void,
	): Promise<string> {
		this.logger.logSystemEvent(LogTypes.downloadImageDelta, { image });

		const deltaOpts = (opts as unknown) as DeltaFetchOptions;
		const srcImage = await this.inspectByName(deltaOpts.deltaSource);

		deltaOpts.deltaSourceId = srcImage.Id;
		const id = await this.docker.fetchDeltaWithProgress(
			image.name,
			deltaOpts,
			onProgress,
		);

		if (!Images.hasDigest(image.name)) {
			const { repo, tag } = await this.docker.getRepoAndTag(image.name);
			await this.docker.getImage(id).tag({ repo, tag });
		}

		return id;
	}

	private fetchImage(
		image: Image,
		opts: FetchOptions,
		onProgress: (evt: FetchProgressEvent) => void,
	): Promise<string> {
		this.logger.logSystemEvent(LogTypes.downloadImage, { image });
		return this.docker.fetchImageWithProgress(image.name, opts, onProgress);
	}

	// TODO: find out if imageId can actually be null
	private reportChange(imageId: Nullable<number>, status?: Partial<Image>) {
		if (imageId == null) {
			return;
		}
		if (status != null) {
			if (this.volatileState[imageId] == null) {
				this.volatileState[imageId] = { imageId } as Image;
			}
			_.merge(this.volatileState[imageId], status);
			return this.emit('change');
		} else if (this.volatileState[imageId] != null) {
			delete this.volatileState[imageId];
			return this.emit('change');
		}
	}

	private static hasDigest(name: Nullable<string>): boolean {
		if (name == null) {
			return false;
		}
		const parts = name.split('@');
		return parts[1] != null;
	}
}

export default Images;
