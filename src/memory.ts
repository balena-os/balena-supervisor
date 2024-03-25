import { memoryUsage } from 'process';

import * as deviceState from './device-state';
import log from './lib/supervisor-console';

export let initialMemory: number = 0;

const processUptime = () => Math.floor(process.uptime());

const secondsToHumanReadable = (seconds: number) => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds - hours * 3600) / 60);
	const secondsRemainder = seconds - hours * 3600 - minutes * 60;
	return `${hours}h ${minutes}m ${secondsRemainder}s`;
};

// 15mb
const MEMORY_THRESHOLD_BYTES = 15 * 1024 * 1024;

/**
 * Returns false if Supervisor process memory usage is above threshold,
 * otherwise returns true.
 */
export async function healthcheck(
	thresholdBytes: number = MEMORY_THRESHOLD_BYTES,
): Promise<boolean> {
	// Measure initial memory after 20 seconds so that startup operations
	// don't affect accuracy.
	if (processUptime() < 20) {
		return true;
	}

	// Pass healthcheck if state isn't settled as we only care about
	// growing base memory usage instead of memory usage spikes.
	if (deviceState.isApplyInProgress()) {
		return true;
	}

	// Pass healthcheck while initial memory usage hasn't been measured
	if (initialMemory === 0) {
		initialMemory = memoryUsage.rss();
		return true;
	}

	// Fail healthcheck if memory usage is above threshold
	if (memoryUsage.rss() > initialMemory + thresholdBytes) {
		log.info(
			`Healthcheck failure - memory usage above threshold after ${secondsToHumanReadable(
				processUptime(),
			)}`,
		);
		return false;
	}

	// Pass healthcheck if memory usage is below threshold
	return true;
}
