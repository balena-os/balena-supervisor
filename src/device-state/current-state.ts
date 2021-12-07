import * as _ from 'lodash';
import * as url from 'url';
import { CoreOptions } from 'request';

import { backoffPromise } from '../lib/backoff';
import { log } from '../lib/supervisor-console';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import * as sysInfo from '../lib/system-info';
import sleep from '../lib/sleep';

import { DeviceStatus } from '../types/state';
import * as config from '../config';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';

const INTERNAL_STATE_KEYS = [
	'update_pending',
	'update_downloaded',
	'update_failed',
];

export let stateReportErrors = 0;

const lastReportedState: DeviceStatus = {
	local: {},
	dependent: {},
};

/**
 * patchInterval is set when startReporting successfuly queries the config
 */
let patchInterval: number;

/**
 * Listen for config changes to statePatchInterval
 */
(async () => {
	await config.initialized;
	config.on('change', (changedConfig) => {
		if (changedConfig.statePatchInterval) {
			patchInterval = changedConfig.statePatchInterval;
		}
	});
})();

/**
 * Returns an object that contains only status fields relevant for the local mode.
 * It basically removes information about applications state.
 */
const stripDeviceStateInLocalMode = (state: DeviceStatus): DeviceStatus => {
	return {
		local: _.cloneDeep(
			_.omit(state.local, 'apps', 'is_on__commit', 'logs_channel'),
		),
	};
};

/**
 * Try to patch difference in device state
 *
 * report attempts to patch the difference in device state from the last
 * report successfully sent.
 */
async function report(stateDiff: Partial<DeviceStatus>): Promise<void> {
	const conf = await config.getMany([
		'deviceApiKey',
		'apiTimeout',
		'apiEndpoint',
		'uuid',
		'localMode',
	]);
	let body = stateDiff;
	const { apiEndpoint, apiTimeout, deviceApiKey, localMode, uuid } = conf;
	if (localMode) {
		body = stripDeviceStateInLocalMode(stateDiff);
	}

	if (_.isEmpty(body.local)) {
		// Nothing to send.
		return;
	}

	if (conf.uuid == null || conf.apiEndpoint == null) {
		throw new InternalInconsistencyError(
			'No uuid or apiEndpoint provided to CurrentState.report',
		);
	}

	const endpoint = url.resolve(apiEndpoint, `/device/v2/${uuid}/state`);
	const request = await getRequestInstance();

	const params: CoreOptions = {
		json: true,
		headers: {
			Authorization: `Bearer ${deviceApiKey}`,
		},
		body,
	};

	const [
		{ statusCode, body: statusMessage, headers },
	] = await request.patchAsync(endpoint, params).timeout(apiTimeout);

	if (statusCode < 200 || statusCode >= 300) {
		throw new StatusError(
			statusCode,
			JSON.stringify(statusMessage, null, 2),
			headers['retry-after'] ? parseInt(headers['retry-after'], 10) : undefined,
		);
	}
}

/**
 * Calculates difference in 2 DeviceStatus objects
 *
 * getStateDiff omits values in newState where value is present in previousState
 */
function getStateDiff(
	previousState: DeviceStatus,
	newState: DeviceStatus,
): Partial<DeviceStatus> {
	if (previousState.local == null || previousState.dependent == null) {
		throw new InternalInconsistencyError(
			`No local or dependent component of previousState in CurrentState.getStateDiff: ${JSON.stringify(
				lastReportedState,
			)}`,
		);
	}

	const diff = {
		local: _.omitBy(
			newState.local,
			(val, key: keyof NonNullable<DeviceStatus['local']>) =>
				INTERNAL_STATE_KEYS.includes(key) ||
				_.isEqual(previousState.local![key], val) ||
				!sysInfo.isSignificantChange(
					key,
					previousState.local![key] as number,
					val as number,
				),
		),
		dependent: _.omitBy(
			newState.dependent,
			(val, key: keyof DeviceStatus['dependent']) =>
				INTERNAL_STATE_KEYS.includes(key) ||
				_.isEqual(previousState.dependent![key], val),
		),
	};

	return _.omitBy(diff, _.isEmpty);
}

/**
 * Get a report for current device state
 *
 * generateReport queries the device for the information needed to
 * update the cloud.
 */
async function generateReport(): Promise<DeviceStatus> {
	// Get current state
	const currentDeviceState = await deviceState.getStatus();
	// Get device metrics and system checks
	const info = {
		...((await config.get('hardwareMetrics'))
			? await sysInfo.getSystemMetrics()
			: {
					cpu_usage: null,
					memory_usage: null,
					memory_total: null,
					storage_usage: null,
					storage_total: null,
					storage_block_device: null,
					cpu_temp: null,
					cpu_id: null,
			  }),
		...(await sysInfo.getSystemChecks()),
	};
	// Return DeviceStatus object
	return {
		local: {
			...currentDeviceState.local,
			...info,
		},
		dependent: {
			...currentDeviceState.dependent,
		},
	};
}

/**
 * Start reporting current state
 *
 * reportHandler will initialize a loop that trys to patch the current
 * state using statePatchInterval as the delay between attempts.
 * If there is an issue with the network request the loop will exponentially
 * back off until successful then reset interval to original time.
 */
export async function reportHandler(attempts = 0): Promise<void> {
	// Generate latest report repesenting the device's current state
	const stateForReport = await generateReport();
	// Calculate differences between current state and last reported state
	const stateDiff = getStateDiff(lastReportedState, stateForReport);
	// Try to send report now
	try {
		await report(stateDiff);
	} catch (e) {
		// Use appUpdatePollInterval as maxDelay since we encountered an error and will backoff now
		const maxDelay = await config.get('appUpdatePollInterval');
		// Check if it was an HTTP status error
		if (e instanceof StatusError) {
			// Supervisor got an HTTP error from API
			log.error(
				`Device state report failure! Status code: ${e.statusCode} - message:`,
				e.message,
			);
			// Use retryAfter as maxDelay if the header is present
			await backoffPromise(
				reportHandler,
				// Do not do exponential backoff if the API reported a retryAfter
				e.retryAfter ? 0 : attempts,
				maxDelay,
				// Start the polling at the value given by the API if any
				e.retryAfter ?? patchInterval,
			);
		} else {
			// Report did not get a HTTP response
			eventTracker.track('Device state report failure', {
				error: e.message,
			});
			await backoffPromise(
				reportHandler,
				stateReportErrors++,
				maxDelay,
				patchInterval,
			);
		}
	}

	// Report was successful so update lastReportedState
	_.assign(lastReportedState.local, stateDiff.local);
	_.assign(lastReportedState.dependent, stateDiff.dependent);
	stateReportErrors = 0;

	// Wait for interval before trying to report again
	await sleep(patchInterval);

	// Begin report loop again with 0 attempts
	return reportHandler(0);
}

export const startReporting = async (): Promise<void> => {
	// Set config values we need to avoid multiple db hits
	patchInterval = await config.get('statePatchInterval');
	// All config values fetch, start reporting!
	return reportHandler();
};
