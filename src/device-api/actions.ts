import { apiKeys } from '.';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import log from '../lib/supervisor-console';
import blink = require('../lib/blink');

/**
 * Run an array of healthchecks, outputting whether all passed or not
 * Used by:
 * - GET /v1/healthy
 */
export const runHealthchecks = async (
	healthchecks: Array<() => Promise<boolean>>,
) => {
	const HEALTHCHECK_FAILURE = 'Healthcheck failed';

	try {
		const checks = await Promise.all(healthchecks.map((fn) => fn()));
		if (checks.some((check) => !check)) {
			throw new Error(HEALTHCHECK_FAILURE);
		}
	} catch {
		log.error(HEALTHCHECK_FAILURE);
		return false;
	}

	return true;
};

/**
 * Identify a device by blinking or some other method, if supported
 * Used by:
 * - POST /v1/blink
 */
const DEFAULT_IDENTIFY_DURATION = 15000;
export const identify = (ms: number = DEFAULT_IDENTIFY_DURATION) => {
	eventTracker.track('Device blink');
	blink.pattern.start();
	setTimeout(blink.pattern.stop, ms);
};

/**
 * Expires the supervisor's API key and generates a new one.
 * Also communicates the new key to the balena API, if it's a cloud key.
 * Used by:
 * - POST /v1/regenerate-api-key
 */
export const regenerateKey = async (oldKey: string) => {
	const shouldUpdateCloudKey = oldKey === apiKeys.cloudApiKey;
	const newKey = await apiKeys.refreshKey(oldKey);

	if (shouldUpdateCloudKey) {
		deviceState.reportCurrentState({
			api_secret: newKey,
		});
	}

	return newKey;
};
