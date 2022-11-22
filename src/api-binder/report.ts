import * as url from 'url';
import _ from 'lodash';
import { delay } from 'bluebird';
import { CoreOptions } from 'request';
import { performance } from 'perf_hooks';

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
	// Pass uuid to report separately to guarantee it exists.
	const uuid = await config.get('uuid');
	if (!uuid) {
		throw new InternalInconsistencyError('No uuid found for local device');
	}

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
			await delay(delayBy);
			// Try to report again
			await recursivelyReport(delayBy);
		}
	}

	// Start monitoring for changes that do not trigger deviceState events
	// Example - device metrics
	return recursivelyReport(maxReportFrequency);
}
