import type ConfigJsonConfigBackend from '../config/configJson';
import log from './supervisor-console';
import { docker } from './docker-utils';
import { isNotFoundError, InternalInconsistencyError } from './errors';

export const EXTRA_FIRMWARE_VOLUME_NAME = 'extra-firmware';

// Extra-firmware is configured if both the volume exists
// and the OS is configured to look for it.
// configJson is passed using dependency injection for easier testing.
export async function isInitialized(configJson: ConfigJsonConfigBackend) {
	let inConfigJson = false;
	try {
		const os = ((await configJson.get('os')) as Dictionary<any>) ?? {};
		inConfigJson = os?.kernel?.extraFirmwareVol === EXTRA_FIRMWARE_VOLUME_NAME;
	} catch (e: unknown) {
		// If there was an error getting the OS configuration,
		// the only reason is that config.json is corrupted.
		throw new InternalInconsistencyError(
			`Error reading config.json while initializing extra firmware volume: ${(e as Error).message}`,
		);
	}
	let volumeExists = false;
	try {
		await docker.getVolume(EXTRA_FIRMWARE_VOLUME_NAME).inspect();
		volumeExists = true;
	} catch (e: unknown) {
		// If volume doesn't exist, proceed with initialization, but if
		// there was some other error getting the volume, there may be
		// an issue in the Engine or OS so we want to throw here.
		if (!isNotFoundError(e)) {
			throw new InternalInconsistencyError(
				`Error getting extra firmware volume: ${(e as Error).message}`,
			);
		}
	}
	return inConfigJson && volumeExists;
}

export async function initialize(configJson: ConfigJsonConfigBackend) {
	log.info('Configuring extra firmware volume');
	// Create volume - volume will be empty unless user includes
	// appropriate linux-firmware block in their docker-compose.
	// The OS is configured to use the volume path on host for firmware,
	// but it's on the user to include the firmware block as well as reboot.
	await create();

	// Configure OS to look for extra firmware volume
	await configureVolume(configJson);
}

// Enable OS to load extra firmware from volume.
// Requires a service OS-side to load firmware from volume path.
// Volume path is derived by the OS from the volume name written to config.json.
const configureVolume = async (configJson: ConfigJsonConfigBackend) => {
	const os: { [key: string]: any } = (await configJson.get('os')) ?? {};
	if (typeof os !== 'object') {
		log.warn('Malformed config.json: os is not an object');
		return;
	}
	os.kernel ??= {};
	if (typeof os.kernel !== 'object') {
		log.warn('Malformed config.json: os.kernel is not an object');
		return;
	}
	// Only configure location if not already configured
	if (os.kernel.extraFirmwareVol === EXTRA_FIRMWARE_VOLUME_NAME) {
		return;
	} else {
		// Other value detected, log and overwrite
		log.info(
			`Extra firmware volume name changed from ${os.kernel.extraFirmwareVol} to ${EXTRA_FIRMWARE_VOLUME_NAME}`,
		);
	}
	os.kernel.extraFirmwareVol = EXTRA_FIRMWARE_VOLUME_NAME;
	await configJson.set({ os });
};

export const create = async () => {
	// No error is thrown if the volume already exists,
	// so if this fails, something went wrong
	await docker.createVolume({
		Name: EXTRA_FIRMWARE_VOLUME_NAME,
	});
};

// Remove and don't throw if volume doesn't exist
export const remove = async () => {
	try {
		await docker.getVolume(EXTRA_FIRMWARE_VOLUME_NAME).remove();
	} catch (e) {
		// If remove returns 404, volume does not exist and we don't need
		// to do anything further, but other errors should get surfaced
		if (!isNotFoundError(e)) {
			throw e;
		}
	}
};
