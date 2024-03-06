import Docker from 'dockerode';
import type { Dockerfile } from 'livepush';
import { Builder } from 'resin-docker-build';

import { promises as fs } from 'fs';
import * as Path from 'path';
import type { Readable } from 'stream';
import * as tar from 'tar-stream';
import * as readline from 'readline';

import { exec } from '../src/lib/fs-utils';

export function getDocker(deviceAddress: string): Docker {
	return new Docker({
		host: deviceAddress,
		// TODO: Make this configurable
		port: 2375,
	});
}

export async function getSupervisorContainer(
	docker: Docker,
	requireRunning: boolean = false,
): Promise<Docker.ContainerInfo> {
	// First get the supervisor container id
	const containers = await docker.listContainers({
		filters: { name: ['balena_supervisor', 'resin_supervisor'] },
		all: !requireRunning,
	});

	if (containers.length !== 1) {
		throw new Error('supervisor container not found');
	}
	return containers[0];
}

export async function getDeviceArch(docker: Docker): Promise<string> {
	try {
		const supervisorContainer = await getSupervisorContainer(docker);
		const arch = supervisorContainer.Labels?.['io.balena.architecture'];
		if (arch == null) {
			// We can try to inspect the image for the
			// architecture if this fails
			const match = /(amd64|i386|aarch64|armv7hf|rpi)/.exec(
				supervisorContainer.Image,
			);
			if (match != null) {
				return match[1];
			}

			throw new Error('supervisor container does not have architecture label');
		}

		return arch.trim();
	} catch (e: any) {
		throw new Error(
			`Unable to get device architecture: ${e.message}.\nTry specifying the architecture with -a.`,
		);
	}
}

export async function getCacheFrom(docker: Docker): Promise<string[]> {
	try {
		const container = await getSupervisorContainer(docker);
		return [container.Image];
	} catch {
		return [];
	}
}

// Source: https://github.com/balena-io/balena-cli/blob/f6d668684a6f5ea8102a964ca1942b242eaa7ae2/lib/utils/device/live.ts#L539-L547
function extractDockerArrowMessage(outputLine: string): string | undefined {
	const arrowTest = /^.*\s*-+>\s*(.+)/i;
	const match = arrowTest.exec(outputLine);
	if (match != null) {
		return match[1];
	}
}

export async function performBuild(
	docker: Docker,
	dockerfile: Dockerfile,
	dockerOpts: { [key: string]: any },
): Promise<string[]> {
	const builder = Builder.fromDockerode(docker);

	// tar the directory, but replace the dockerfile with the
	// livepush generated one
	const tarStream = await tarDirectory(Path.join(__dirname, '..'), dockerfile);

	return new Promise((resolve, reject) => {
		// Store the stage ids for caching
		const ids = [] as string[];
		builder.createBuildStream(dockerOpts, {
			buildSuccess: () => {
				// Return the image ids
				resolve(ids);
			},
			buildFailure: reject,
			buildStream: (input: NodeJS.ReadWriteStream) => {
				// Parse the build output to get stage ids and
				// for logging
				let lastArrowMessage: string | undefined;
				readline.createInterface({ input }).on('line', (line) => {
					// If this was a FROM line, take the last found
					// image id and save it as a stage id
					// Source: https://github.com/balena-io/balena-cli/blob/f6d668684a6f5ea8102a964ca1942b242eaa7ae2/lib/utils/device/live.ts#L300-L325
					if (
						/step \d+(?:\/\d+)?\s*:\s*FROM/i.test(line) &&
						lastArrowMessage != null
					) {
						ids.push(lastArrowMessage);
					} else {
						const msg = extractDockerArrowMessage(line);
						if (msg != null) {
							lastArrowMessage = msg;
						}
					}

					// Log the build line
					console.info(line);
				});

				// stream.pipe(bufStream);
				tarStream.pipe(input);
			},
		});
	});
}

async function tarDirectory(
	dir: string,
	dockerfile: Dockerfile,
): Promise<Readable> {
	const pack = tar.pack();

	const add = async (path: string) => {
		const entries = await fs.readdir(path);
		for (const entry of entries) {
			const newPath = Path.resolve(path, entry);
			// Here we filter the things we don't want
			if (
				newPath.includes('node_modules/') ||
				newPath.includes('.git/') ||
				newPath.includes('build/') ||
				newPath.includes('coverage/')
			) {
				continue;
			}
			// We use lstat here, otherwise an error will be
			// thrown on a symbolic link
			const stat = await fs.lstat(newPath);
			if (stat.isDirectory()) {
				await add(newPath);
			} else {
				if (newPath.endsWith('Dockerfile.template')) {
					pack.entry(
						{ name: 'Dockerfile', mode: stat.mode, size: stat.size },
						dockerfile.generateLiveDockerfile(),
					);
					continue;
				}

				pack.entry(
					{
						name: Path.relative(dir, newPath),
						mode: stat.mode,
						size: stat.size,
					},
					await fs.readFile(newPath),
				);
			}
		}
	};

	await add(dir);
	pack.finalize();
	return pack;
}

// Absolutely no escaping in this function, just be careful
async function runSshCommand(address: string, command: string) {
	// TODO: Make the port configurable
	const { stdout } = await exec(
		'ssh -p 22222 -o LogLevel=ERROR ' +
			'-o StrictHostKeyChecking=no ' +
			'-o UserKnownHostsFile=/dev/null ' +
			`root@${address} ` +
			`"${command}"`,
	);
	return stdout;
}

export async function stopSupervisor(address: string) {
	try {
		await runSshCommand(address, 'systemctl stop balena-supervisor');
	} catch {
		await runSshCommand(address, 'systemctl stop resin-supervisor');
	}
}

export async function startSupervisor(address: string) {
	try {
		await runSshCommand(address, 'systemctl start balena-supervisor');
	} catch {
		await runSshCommand(address, 'systemctl start resin-supervisor');
	}
}

export async function replaceSupervisorImage(
	address: string,
	imageName: string,
	imageTag: string,
) {
	// TODO: Maybe don't overwrite the LED file?
	const fileStr = `#This file was edited by livepush
SUPERVISOR_IMAGE=${imageName}
SUPERVISOR_TAG=${imageTag}
LED_FILE=/dev/null
`;

	return runSshCommand(
		address,
		`echo '${fileStr}' > /tmp/update-supervisor.conf`,
	);
}

export async function readBuildCache(address: string): Promise<string[]> {
	const cache = await runSshCommand(
		address,
		`cat /tmp/livepush-cache.json || true`,
	);
	return JSON.parse(cache || '[]');
}

export async function writeBuildCache(address: string, stageImages: string[]) {
	// Convert the list to JSON with escaped quotes
	const contents = JSON.stringify(stageImages).replace(/["]/g, '\\"');
	return runSshCommand(
		address,
		`echo '${contents}' > /tmp/livepush-cache.json`,
	);
}
