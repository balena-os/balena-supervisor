import * as Docker from 'dockerode';
import * as tar from 'tar-stream';

// Creates an image from scratch with just some labels
export async function createDockerImage(
	name: string,
	labels: [string, ...string[]],
	docker = new Docker(),
) {
	const pack = tar.pack(); // pack is a streams2 stream
	pack.entry(
		{ name: 'Dockerfile' },
		['FROM scratch'].concat(labels.map((l) => `LABEL ${l}`)).join('\n'),
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
		docker.modem.followProgress(stream, (err: any, res: any) =>
			err ? reject(err) : resolve(res),
		);
	});
}
