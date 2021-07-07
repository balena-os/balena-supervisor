import * as _ from 'lodash';
import blink = require('./blink');
import { DeviceStatus, InstancedDeviceState } from '../types/state';
import * as deviceState from '../device-state';

interface ServiceState {
	id: string;
	status: string;
	download_progress: number | null;
}

/*
 * Blink the device LED with a frequency proportional to the download progress.
 * Start fast and slow down as the download progresses. This provides an easy to spot "fade away" pattern.
 */
const DOWNLOAD_BLINK_PERIOD_BASE = 100; // Initialize on/off periods at 100 msec - 5 blinks per second at 0%
const DOWNLOAD_BLINK_PERIOD_STEP = 9; // Increment by 9 msec for each % - 1 blink every 2 seconds at 100%

// Throttled blink means the LED reporting could be inaccurate for at most the throttle period, so we keep it to a small value
const DOWNLOAD_BLINK_THROTTLE = 10000;
const throttledBlink = _.throttle((progress: number) => {
	blink.pattern.stop();
	if (progress < 100) {
		const onOffDuration =
			DOWNLOAD_BLINK_PERIOD_BASE + DOWNLOAD_BLINK_PERIOD_STEP * progress;
		blink.pattern.start({
			blinks: 1,
			pause: 0,
			onDuration: onOffDuration,
			offDuration: onOffDuration,
		});
	}
}, DOWNLOAD_BLINK_THROTTLE);

export async function downloadProgress() {
	// Get target services and current state
	const currentDeviceState = await deviceState.getStatus();
	const currentServicesStates = getCurrentServicesStates(currentDeviceState);
	const targetDeviceState = await deviceState.getTarget();
	const targetServicesIDs = getTargetServicesIds(targetDeviceState);

	if (
		currentDeviceState.local?.update_pending &&
		targetServicesIDs.length > 0
	) {
		// Calculate overall progress
		let progress = 0;
		for (const id of targetServicesIDs) {
			const service = currentServicesStates.find((s) => s.id === id);
			if (service) {
				if (['Downloaded', 'Installing', 'Running'].includes(service.status)) {
					// States after 'Downloading' report 'null' download_progress. Patch those to 100%
					progress += 100;
				} else {
					progress += service.download_progress ?? 0;
				}
			}
		}
		progress /= targetServicesIDs.length;

		// Blink!
		throttledBlink(progress);
	} else {
		blink.pattern.stop();
	}
}

function getTargetServicesIds(target: InstancedDeviceState): string[] {
	return Object.values(target.local?.apps).flatMap((app) =>
		app.services.map((s) => s.imageId.toString()),
	);
}

function getCurrentServicesStates(current: DeviceStatus): ServiceState[] {
	return Object.values(current.local?.apps || {}).flatMap((app) =>
		Object.entries(app.services).flatMap(([serviceId, serviceDetails]) => ({
			id: serviceId,
			status: serviceDetails.status,
			download_progress: serviceDetails.download_progress,
		})),
	);
}
