import * as url from 'url';
import * as _ from 'lodash';
import { delay } from 'bluebird';
import { CoreOptions } from 'request';

import * as constants from '../lib/constants';
import { log } from '../lib/supervisor-console';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import { DeviceState } from '../types';
import * as config from '../config';
import { SchemaTypeKey, SchemaReturn } from '../config/schema-type';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import { shallowDiff, prune, empty } from '../lib/json';

import { OnRetry, AbortLimit, withBackoff, withThrottle } from '../lib/limit';

let lastReport: DeviceState = {};
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

async function reportCurrentState(opts: StateReportOpts) {
	// Wrap the report with fetching of state so report always has the latest state diff
	const getStateAndReport = async () => {
		const currentState = await deviceState.getCurrentForReport(lastReport);
		const stateDiff = prune(shallowDiff(lastReport, currentState, 2));

		if (empty(stateDiff)) {
			throw new AbortLimit();
		}

		await report({ body: stateDiff, opts });
		lastReport = currentState;
		log.info(`${new Date()} - Reported current state to the cloud`);
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
	} catch (e) {
		if (e instanceof AbortLimit) {
			// Throw AbortLimit because reportCurrentState uses a throttle
			// this aborts any pending reports so that the next call runs right away
			throw e;
		} else {
			log.error(e);
		}
	}
}

function handleRetry(retryInfo: OnRetry) {
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

		// Increase the counter so the healthcheck gets triggered
		// if too many connectivity errors occur
		stateReportErrors++;
	}
	log.info(
		`Retrying current state report in ${retryInfo.delay / 1000} seconds`,
	);
}

export async function startReporting() {
	// Get configs needed to make a report
	const reportConfigs = (await config.getMany([
		'apiEndpoint',
		'apiTimeout',
		'deviceApiKey',
		'appUpdatePollInterval',
	])) as StateReportOpts;

	const throttledReport = withThrottle(
		reportCurrentState,
		constants.maxReportFrequency,
	);

	const doReport = async () => {
		try {
			await throttledReport(reportConfigs);
		} catch (e) {
			// noop
		}
	};
	// If the state changes, report it
	deviceState.on('change', doReport);

	async function recursivelyReport(delayBy: number) {
		try {
			// Try to send current state
			await doReport();
		} finally {
			// Wait until we want to report again
			await delay(delayBy);
			// Try to report again
			await recursivelyReport(delayBy);
		}
	}

	// Start monitoring for changes that do not trigger deviceState events
	// Example - device metrics
	return recursivelyReport(constants.maxReportFrequency);
}
