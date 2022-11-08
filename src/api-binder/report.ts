import * as url from 'url';
import * as _ from 'lodash';
import { delay } from 'bluebird';
import { CoreOptions } from 'request';
import { performance } from 'perf_hooks';

import * as constants from '../lib/constants';
import { withBackoff, OnFailureInfo } from '../lib/backoff';
import { log } from '../lib/supervisor-console';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';

import { DeviceState } from '../types';
import * as config from '../config';
import { SchemaTypeKey, SchemaReturn } from '../config/schema-type';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';

import { shallowDiff, prune, empty } from '../lib/json';

let lastReport: DeviceState = {};
let lastReportTime: number = -Infinity;
// Tracks if unable to report the latest state change event.
let stateChangeDeferred: boolean = false;
// How often can we report our state to the server in ms
const maxReportFrequency = 10 * 1000;
// How often can we report metrics to the server in ms; mirrors server setting.
// Metrics are low priority, so less frequent than maxReportFrequency.
const maxMetricsFrequency = 300 * 1000;

// TODO: This counter is read by the healthcheck to see if the
// supervisor is having issues to connect. We have removed the
// lines of code to increase the counter on network error as
// we suspect that is really making things worst. This will
// most likely get removed in the future.
export let stateReportErrors = 0;

type StateReportOpts = {
	[key in keyof Pick<
		config.ConfigMap<SchemaTypeKey>,
		'apiEndpoint' | 'apiTimeout' | 'deviceApiKey' | 'appUpdatePollInterval'
	>]: SchemaReturn<key>;
};

type StateReport = { body: Partial<DeviceState>; opts: StateReportOpts };

async function report({ body, opts }: StateReport) {
	const { apiEndpoint, apiTimeout, deviceApiKey } = opts;

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
		.timeout(apiTimeout);

	if (statusCode < 200 || statusCode >= 300) {
		throw new StatusError(
			statusCode,
			JSON.stringify(statusMessage, null, 2),
			headers['retry-after'] ? parseInt(headers['retry-after'], 10) : undefined,
		);
	}
}

async function reportCurrentState(opts: StateReportOpts) {
	// Wrap the report with fetching of state so report always has the latest state diff
	const getStateAndReport = async () => {
		const now = performance.now();
		// Only try to report if enough time has elapsed since last report
		if (now - lastReportTime >= maxReportFrequency) {
			const currentState = await deviceState.getCurrentForReport(lastReport);
			const stateDiff = prune(shallowDiff(lastReport, currentState, 2));

			if (empty(stateDiff)) {
				return;
			}

			await report({ body: stateDiff, opts });
			lastReportTime = performance.now();
			lastReport = currentState;
			log.info('Reported current state to the cloud');
		} else {
			// Not enough time has elapsed since last report
			// Delay report until next allowed time
			const timeSinceLastReport = now - lastReportTime;
			await delay(maxReportFrequency - timeSinceLastReport);
			await getStateAndReport();
		}
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
			error: retryInfo.error?.message ?? retryInfo.error,
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
		'apiTimeout',
		'deviceApiKey',
		'appUpdatePollInterval',
	])) as StateReportOpts;

	let reportPending = false;
	// Reports current state if not already sending and does not exceed report
	// frequency. Returns true if sent; otherwise false.
	const doReport = async (): Promise<boolean> => {
		if (!reportPending) {
			if (performance.now() - lastReportTime > maxReportFrequency) {
				reportPending = true;
				await reportCurrentState(reportConfigs);
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
		// Defers to timed report schedule if we can't report immediately.
		// Ensures that we always report on a change event.
		stateChangeDeferred = !(await doReport());
	};

	// If the state changes, report it
	deviceState.on('change', onStateChange);

	async function recursivelyReport(delayBy: number) {
		try {
			// Follow-up when report not sent immediately on change event...
			if (stateChangeDeferred) {
				stateChangeDeferred = !(await doReport());
			} else {
				// ... or on regular metrics schedule.
				if (performance.now() - lastReportTime > maxMetricsFrequency) {
					await doReport();
				}
			}
		} finally {
			// Wait until we want to report again
			await delay(delayBy);
			// Try to report again
			await recursivelyReport(delayBy);
		}
	}

	// Start monitoring for changes that do not trigger deviceState events
	// Example - device metrics
	return recursivelyReport(maxReportFrequency);
}
