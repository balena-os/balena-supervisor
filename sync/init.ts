import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import { Dockerfile } from 'livepush';

import * as device from './device';

interface Opts {
	address: string;
	imageName: string;
	imageTag: string;
	docker: Docker;
	dockerfile: Dockerfile;
	nocache: boolean;
	arch?: string;
}

// Source: https://github.com/balena-io/balena-cli/blob/f6d668684a6f5ea8102a964ca1942b242eaa7ae2/lib/utils/device/live.ts#L539-L547
function extractDockerArrowMessage(outputLine: string): string | undefined {
	const arrowTest = /^.*\s*-+>\s*(.+)/i;
	const match = arrowTest.exec(outputLine);
	if (match != null) {
		return match[1];
	}
}

// Source: https://github.com/balena-io/balena-cli/blob/f6d668684a6f5ea8102a964ca1942b242eaa7ae2/lib/utils/device/live.ts#L300-L325
function getMultiStateImageIDs(buildLog: string): string[] {
	const ids = [] as string[];
	const lines = buildLog.split(/\r?\n/);
	let lastArrowMessage: string | undefined;
	for (const line of lines) {
		// If this was a from line, take the last found
		// image id and save it
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
	}

	return ids;
}

function getPathPrefix(arch: string) {
	switch (arch) {
		/**
		 * Proper paths are
		 * - armv6 - arm32v6
		 * - armv7hf - arm32v7
		 * - aarch64 - arm64v8
		 * - amd64 - amd64
		 * - i386 - i386
		 *
		 * We only set the prefix for v6 images since rpi devices are
		 * the only ones that seem to have the issue
		 * https://github.com/balena-os/balena-engine/issues/269
		 */
		case 'rpi':
			return 'arm32v6';
		default:
			return 'library';
	}
}

export async function initDevice(opts: Opts) {
	const arch = opts.arch ?? (await device.getDeviceArch(opts.docker));
	const image = `${opts.imageName}:${opts.imageTag}`;

	const buildCache = await device.readBuildCache(opts.address);

	const buildLog = await device.performBuild(opts.docker, opts.dockerfile, {
		buildargs: { ARCH: arch, PREFIX: getPathPrefix(arch) },
		t: image,
		labels: { 'io.balena.livepush-image': '1', 'io.balena.architecture': arch },
		cachefrom: (await device.getCacheFrom(opts.docker))
			.concat(image)
			.concat(buildCache),
		nocache: opts.nocache,
	});

	const stageImages = getMultiStateImageIDs(buildLog);

	// Store the list of stage images for the next time the sync
	// command is called. This will only live until the device is rebooted
	await device.writeBuildCache(opts.address, stageImages);

	// Now that we have our new image on the device, we need
	// to stop the supervisor, update
	// /tmp/update-supervisor.conf with our version, and
	// restart the supervisor
	await device.stopSupervisor(opts.address);
	await device.replaceSupervisorImage(
		opts.address,
		opts.imageName,
		opts.imageTag,
	);
	await device.startSupervisor(opts.address);

	let supervisorContainer: undefined | Docker.ContainerInfo;
	while (supervisorContainer == null) {
		try {
			supervisorContainer = await device.getSupervisorContainer(
				opts.docker,
				true,
			);
		} catch {
			await Bluebird.delay(500);
		}
	}
	return { containerId: supervisorContainer.Id, stageImages };
}
