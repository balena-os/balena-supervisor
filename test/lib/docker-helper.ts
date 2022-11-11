import * as Docker from 'dockerode';
import * as tar from 'tar-stream';
import { setTimeout } from 'timers/promises';
import { strict as assert } from 'assert';

import { supervisorImage } from '~/lib/constants';
import { isStatusError } from '~/lib/errors';

export const BASE_IMAGE = 'alpine:latest';

// Creates an image from scratch with just some labels
export async function createDockerImage(
	name: string,
	labels: [string, ...string[]],
	docker = new Docker(),
	extra = [] as string[], // Additional instructions to add to the dockerfile
): Promise<string> {
	const pack = tar.pack(); // pack is a streams2 stream
	pack.entry(
		{ name: 'Dockerfile' },
		['FROM scratch']
			.concat(labels.map((l) => `LABEL ${l}`))
			.concat(extra)
			.join('\n'),
		(err) => {
			if (err) {
				throw err;
			}
			pack.finalize();
		},
	);
	// Create an empty image
	const stream = await docker.buildImage(pack, { t: name });
	return await new Promise((resolve, reject) => {
		docker.modem.followProgress(stream, (err: any, res: any) => {
			if (err) {
				reject(err);
			}

			const ids = res
				.map((evt: any) => evt?.aux?.ID ?? null)
				.filter((id: string | null) => !!id);

			assert(ids.length > 0, 'expected at least an image id after building');
			resolve(ids[ids.length - 1]);
		});
	});
}

/**
 * In integration test env, the Supervisor container expects an image
 * tagged balena/$ARCH-supervisor to be able to apply target state.
 * We can't access the SV container for stubbing the method that
 * checks the presence of this image, so a minimal image should
 * be pulled and tagged.
 */
export const setupSupervisorImage = async () => {
	const docker = new Docker();
	await docker.pull(BASE_IMAGE);
	// Wait for alpine:latest to finish pulling
	while (true) {
		if ((await docker.listImages()).length > 0) {
			break;
		}
		await setTimeout(500);
	}
	// Tag alpine as balena/$ARCH-supervisor:latest
	await docker
		.getImage(BASE_IMAGE)
		.tag({ repo: supervisorImage, tag: 'latest' });
};

/**
 * Clean up Docker artifacts from integration tests.
 */
export const cleanupDocker = async ({
	docker = new Docker(),
	imagesToExclude = [BASE_IMAGE, supervisorImage],
} = {}) => {
	// Remove all containers
	// Some containers may still be running so a prune won't suffice
	try {
		const containers = await docker.listContainers({ all: true });
		await Promise.all(
			containers.map(({ Id }) =>
				docker.getContainer(Id).remove({ force: true }),
			),
		);
	} catch (e: unknown) {
		// Sometimes a container is already in the process of being removed
		// This is safe to ignore since we're removing them anyway.
		if (isStatusError(e) && e.statusCode !== 409) {
			throw e;
		}
	}

	// Remove all networks except defaults
	const networks = await docker.listNetworks();
	await Promise.all(
		networks
			// exclude docker default network from the cleanup
			.filter(({ Name }) => !['bridge', 'host', 'none'].includes(Name))
			.map(({ Name }) => docker.getNetwork(Name).remove()),
	);

	// Remove all volumes
	await docker.pruneVolumes();

	// Remove all images except optionally excluded ones
	const images = await docker.listImages();
	const toRemove = images
		.filter(
			({ RepoTags }) => !imagesToExclude.some((img) => RepoTags.includes(img)),
		)
		.map(({ RepoTags }) => RepoTags)
		.flat();
	// Remove images in serial because removing 2 tags referencing
	// the same image at once will error
	for (const repoTag of toRemove) {
		await docker.getImage(repoTag).remove();
	}
};
