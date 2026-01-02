import url from 'url';
import type { CoreOptions } from 'request';
import { performance } from 'perf_hooks';
import { setTimeout } from 'timers/promises';
import { readFile } from 'fs/promises';

import { DeviceState } from '../types';
import * as config from '../config';
import type { SchemaTypeKey, SchemaReturn } from '../config/schema-type';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';

import type { OnFailureInfo } from '../lib/backoff';
import { withBackoff } from '../lib/backoff';
import { log } from '../lib/supervisor-console';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import { shallowDiff, prune, empty } from '../lib/json';
import { pathOnRoot } from '../lib/host-utils';
import { touch, writeAndSyncFile } from '../lib/fs-utils';

let lastReport: DeviceState = {};
let lastReportTime = -Infinity;
// Tracks if unable to report the latest state change event.
let stateChangeDeferred = false;
// How often can we report our state to the server in ms
const maxReportFrequency = 10 * 1000;
// How often can we report metrics to the server in ms; mirrors server setting.
// Metrics are low priority, so less frequent than maxReportFrequency.
const maxMetricsFrequency = 300 * 1000;
// Path of the cache for last reported state.
// This cache stores the last successfully reported device state to the cloud,
// allowing the supervisor to only send state differences on subsequent reports.
// The cache survives supervisor restarts but is cleared on device reboot.
// See docs/debugging-supervisor.md for more information.
const CACHE_PATH = pathOnRoot('/tmp/balena-supervisor/state-report-cache');

// TODO: This counter is read by the healthcheck to see if the
// supervisor is having issues to connect. We have removed the
// lines of code to increase the counter on network error as
// we suspect that is really making things worst. This will
// most likely get removed in the future.
export let stateReportErrors = 0;

type StateReportOpts = {
	[key in keyof Pick<
		config.ConfigMap<SchemaTypeKey>,
		| 'apiEndpoint'
		| 'apiRequestTimeout'
		| 'deviceApiKey'
		| 'appUpdatePollInterval'
	>]: SchemaReturn<key>;
};

type StateReport = { body: Partial<DeviceState>; opts: StateReportOpts };

async function report({ body, opts }: StateReport) {
	const { apiEndpoint, apiRequestTimeout, deviceApiKey } = opts;

	if (!apiEndpoint) {
		throw new InternalInconsistencyError(
			'No apiEndpoint available for patching current state',
		);
	}

	const endpoint = url.resolve(apiEndpoint, `/device/v3/state`);
	const request = await getRequestInstance();

	const params: CoreOptions = {
		json: true,
		headers: {
			Authorization: `Bearer ${deviceApiKey}`,
		},
		body,
	};

	const [{ statusCode, body: statusMessage, headers }] = await request
		.patchAsync(endpoint, params)
		.timeout(apiRequestTimeout);

	if (statusCode < 200 || statusCode >= 300) {
		throw new StatusError(
			statusCode,
			JSON.stringify(statusMessage, null, 2),
			headers['retry-after'] ? parseInt(headers['retry-after'], 10) : undefined,
		);
	}
}

/**
 * Collects current state and reports with backoff. Diffs report content with
 * previous report and does not send an empty report.
 *
 * Does *not* validate time elapsed since last report.
 */
async function reportCurrentState(opts: StateReportOpts, uuid: string) {
	const getStateAndReport = async () => {
		const currentState = await deviceState.getCurrentForReport(lastReport);
		const stateDiff = prune(shallowDiff(lastReport, currentState, 2));

		if (empty(stateDiff)) {
			return;
		}

		// If metrics not yet scheduled, report must include a state change to
		// qualify for sending.
		const metricsScheduled =
			performance.now() - lastReportTime > maxMetricsFrequency;
		if (!metricsScheduled) {
			const uuidMap = stateDiff[uuid] as { [k: string]: any };
			if (
				Object.keys(uuidMap).every((n) =>
					deviceState.sysInfoPropertyNames.includes(n),
				)
			) {
				return;
			}
		}

		await report({ body: stateDiff, opts });
		lastReportTime = performance.now();
		lastReport = currentState;

		// Cache last report so it survives Supervisor restart.
		// On Supervisor startup, Supervisor will be able to diff between the
		// cached report and thereby report less unnecessary data.
		await cache(currentState);

		log.info('Reported current state to the cloud');
	};

	// Create a report that will backoff on errors
	const reportWithBackoff = withBackoff(getStateAndReport, {
		maxDelay: opts.appUpdatePollInterval,
		minDelay: 15000,
		onFailure: handleRetry,
	});

	// Run in try block to avoid throwing any exceptions
	try {
		await reportWithBackoff();
		stateReportErrors = 0;
	} catch (e) {
		log.error(e);
	}
}

/**
 * Cache last reported current state to CACHE_PATH
 */
async function cache(state: DeviceState) {
	try {
		await writeAndSyncFile(CACHE_PATH, JSON.stringify(state));
	} catch (e: unknown) {
		log.debug(`Failed to cache last reported state: ${(e as Error).message}`);
	}
}

/**
 * Get last cached state report from CACHE_PATH
 */
async function getCache(): Promise<DeviceState> {
	try {
		// Touch the file, which will create it if it doesn't exist
		await touch(CACHE_PATH);

		// Get last reported current state
		const rawStateCache = await readFile(CACHE_PATH, 'utf-8');
		const state = JSON.parse(rawStateCache);

		// Return current state cache if valid
		if (!DeviceState.is(state)) {
			throw new Error();
		}
		log.debug('Retrieved last reported state from cache');
		return state;
	} catch {
		log.debug(
			'Could not retrieve last reported state from cache, proceeding with empty cache',
		);
		return {};
	}
}

function handleRetry(retryInfo: OnFailureInfo) {
	if (retryInfo.error instanceof StatusError) {
		// We don't want these errors to be classed as a report error, as this will cause
		// the watchdog to kill the supervisor - and killing the supervisor will
		// not help in this situation
		log.error(
			`Device state report failure! Status code: ${retryInfo.error.statusCode} - message:`,
			retryInfo.error?.message ?? retryInfo.error,
		);
	} else {
		eventTracker.track('Device state report failure', {
			error: retryInfo.error,
		});
	}
	log.info(
		`Retrying current state report in ${retryInfo.delay / 1000} seconds`,
	);
}

/**
 * Sends state report to cloud from two sources: 1) state change events and
 * 2) timer for metrics. Report frequency is at most maxReportFrequency, and
 * metrics is reported at most maxMetricsFrequency.
 */
export async function startReporting() {
	// Get configs needed to make a report
	const reportConfigs = (await config.getMany([
		'apiEndpoint',
		'apiRequestTimeout',
		'deviceApiKey',
		'appUpdatePollInterval',
	])) as StateReportOpts;
	// Pass uuid to report separately to guarantee it exists.
	const uuid = await config.get('uuid');
	if (!uuid) {
		throw new InternalInconsistencyError('No uuid found for local device');
	}

	// Get last reported state from cache
	lastReport = await getCache();

	let reportPending = false;
	// Reports current state if not already sending and prevents a state change
	// from exceeding report frequency. Returns true if sent; otherwise false.
	const doReport = async (): Promise<boolean> => {
		if (!reportPending) {
			if (performance.now() - lastReportTime > maxReportFrequency) {
				// Can't wait until report complete to clear deferred marker.
				// Change events while in progress will set deferred marker synchronously.
				// Ensure we don't miss reporting a change event.
				stateChangeDeferred = false;
				reportPending = true;
				await reportCurrentState(reportConfigs, uuid);
				reportPending = false;
				return true;
			} else {
				return false;
			}
		} else {
			return false;
		}
	};

	const onStateChange = async () => {
		// State change events are async, but may arrive in rapid succession.
		// Defers to a timed report schedule if we can't report immediately, to
		// ensure we don't miss reporting an event.
		if (!(await doReport())) {
			stateChangeDeferred = true;
		}
	};

	// If the state changes, report it
	deviceState.on('change', onStateChange);

	async function recursivelyReport(delayBy: number) {
		try {
			// Follow-up when report not sent immediately on change event...
			if (stateChangeDeferred) {
				if (!(await doReport())) {
					stateChangeDeferred = true;
				}
			} else {
				// ... or on regular metrics schedule.
				if (performance.now() - lastReportTime > maxMetricsFrequency) {
					await doReport();
				}
			}
		} finally {
			// Wait until we want to report again
			await setTimeout(delayBy);
			// Try to report again
			// the void is necessary to break the recursion and avoid leaks
			void recursivelyReport(delayBy);
		}
	}

	// Start monitoring for changes that do not trigger deviceState events
	// Example - device metrics
	return recursivelyReport(maxReportFrequency);
}
