import * as Docker from 'dockerode';
import * as tar from 'tar-stream';
import { strict as assert } from 'assert';

import { isStatusError } from '~/lib/errors';

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

// Clean up all Docker relics from tests
export const cleanupDocker = async (docker = new Docker()) => {
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
			.filter(({ Name }) => !['bridge', 'host', 'none'].includes(Name)) // exclude docker default network from the cleanup
			.map(({ Name }) => docker.getNetwork(Name).remove()),
	);

	// Remove all volumes
	const { Volumes } = await docker.listVolumes();
	await Promise.all(Volumes.map(({ Name }) => docker.getVolume(Name).remove()));

	// Remove all images
	await docker.pruneImages({ filters: { dangling: { false: true } } });
};
