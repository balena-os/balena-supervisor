import Bluebird from 'bluebird';
import Docker from 'dockerode';
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

	const stageImages = await device.performBuild(opts.docker, opts.dockerfile, {
		buildargs: { ARCH: arch, PREFIX: getPathPrefix(arch) },
		t: image,
		labels: { 'io.balena.livepush-image': '1', 'io.balena.architecture': arch },
		cachefrom: (await device.getCacheFrom(opts.docker))
			.concat(image)
			.concat(buildCache),
		nocache: opts.nocache,
	});

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
