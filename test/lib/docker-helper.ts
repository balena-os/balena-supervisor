import Docker from 'dockerode';
import * as tar from 'tar-stream';

import { strict as assert } from 'assert';

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
