import * as _ from 'lodash';
import * as url from 'url';
import { CoreOptions } from 'request';

import * as constants from '../lib/constants';
import { withBackoff, OnFailureInfo } from '../lib/backoff';
import { log } from '../lib/supervisor-console';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import * as sysInfo from '../lib/system-info';

import { DeviceLegacyState } from '../types';
import * as config from '../config';
import { SchemaTypeKey, SchemaReturn } from '../config/schema-type';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';

const INTERNAL_STATE_KEYS = [
	'update_pending',
	'update_downloaded',
	'update_failed',
];

export let stateReportErrors = 0;
const lastReportedState: DeviceLegacyState = {
	local: {},
	dependent: {},
};
let reportPending = false;

type CurrentStateReportConf = {
	[key in keyof Pick<
		config.ConfigMap<SchemaTypeKey>,
		| 'uuid'
		| 'apiEndpoint'
		| 'apiTimeout'
		| 'deviceApiKey'
		| 'deviceId'
		| 'localMode'
		| 'appUpdatePollInterval'
		| 'hardwareMetrics'
	>]: SchemaReturn<key>;
};

type StateReport = {
	stateDiff: DeviceLegacyState;
	conf: Omit<CurrentStateReportConf, 'deviceId' | 'hardwareMetrics'>;
};

/**
 * Returns an object that contains only status fields relevant for the local mode.
 * It basically removes information about applications state.
 */
const stripDeviceStateInLocalMode = (
	state: DeviceLegacyState,
): DeviceLegacyState => {
	return {
		local: _.cloneDeep(
			_.omit(state.local, 'apps', 'is_on__commit', 'logs_channel'),
		),
	};
};

async function report({ stateDiff, conf }: StateReport): Promise<boolean> {
	let body = stateDiff;
	const { apiEndpoint, apiTimeout, deviceApiKey, localMode, uuid } = conf;
	if (localMode) {
		body = stripDeviceStateInLocalMode(stateDiff);
	}

	if (_.isEmpty(body.local)) {
		// Nothing to send.
		return false;
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
	// State was reported
	return true;
}

function newStateDiff(stateForReport: DeviceLegacyState): DeviceLegacyState {
	const lastReportedLocal = lastReportedState.local;
	const lastReportedDependent = lastReportedState.dependent;
	if (lastReportedLocal == null || lastReportedDependent == null) {
		throw new InternalInconsistencyError(
			`No local or dependent component of lastReportedLocal in CurrentState.getStateDiff: ${JSON.stringify(
				lastReportedState,
			)}`,
		);
	}

	const diff = {
		local: _.omitBy(
			stateForReport.local,
			(val, key: keyof NonNullable<DeviceLegacyState['local']>) =>
				INTERNAL_STATE_KEYS.includes(key) ||
				_.isEqual(lastReportedLocal[key], val) ||
				!sysInfo.isSignificantChange(
					key,
					lastReportedLocal[key] as number,
					val as number,
				),
		),
		dependent: _.omitBy(
			stateForReport.dependent,
			(val, key: keyof DeviceLegacyState['dependent']) =>
				INTERNAL_STATE_KEYS.includes(key) ||
				_.isEqual(lastReportedDependent[key], val),
		),
	};

	return _.omitBy(diff, _.isEmpty);
}

async function reportCurrentState(conf: CurrentStateReportConf) {
	// Ensure no other report starts
	reportPending = true;
	// Wrap the report with fetching of state so report always has the latest state diff
	const getStateAndReport = async () => {
		// Get state to report
		const stateToReport = await generateStateForReport();
		// Get diff from last reported state
		const stateDiff = newStateDiff(stateToReport);
		// Report diff
		if (await report({ stateDiff, conf })) {
			// Update lastReportedState
			_.assign(lastReportedState.local, stateDiff.local);
			_.assign(lastReportedState.dependent, stateDiff.dependent);
			// Log that we successfully reported the current state
			log.info('Reported current state to the cloud');
		}
	};
	// Create a report that will backoff on errors
	const reportWithBackoff = withBackoff(getStateAndReport, {
		maxDelay: conf.appUpdatePollInterval,
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
	reportPending = false;
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

		// Increase the counter so the healthcheck gets triggered
		// if too many connectivity errors occur
		stateReportErrors++;
	}
	log.info(
		`Retrying current state report in ${retryInfo.delay / 1000} seconds`,
	);
}

async function generateStateForReport() {
	const { hardwareMetrics } = await config.getMany(['hardwareMetrics']);

	const currentDeviceState = await deviceState.getLegacyState();

	// If hardwareMetrics is false, send null patch for system metrics to cloud API
	const info = {
		...(hardwareMetrics
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

	return {
		local: {
			...currentDeviceState.local,
			...info,
		},
		dependent: currentDeviceState.dependent,
	};
}

export async function startReporting() {
	// Get configs needed to make a report
	const reportConfigs = (await config.getMany([
		'uuid',
		'apiEndpoint',
		'apiTimeout',
		'deviceApiKey',
		'deviceId',
		'localMode',
		'appUpdatePollInterval',
		'hardwareMetrics',
	])) as CurrentStateReportConf;
	// Throttle reportCurrentState so we don't query device or hit API excessively
	const throttledReport = _.throttle(
		reportCurrentState,
		constants.maxReportFrequency,
	);
	const doReport = async () => {
		if (!reportPending) {
			throttledReport(reportConfigs);
		}
	};

	// If the state changes, report it
	deviceState.on('change', doReport);
	// But check once every max report frequency to ensure that changes in system
	// info are picked up (CPU temp etc)
	setInterval(doReport, constants.maxReportFrequency);
	// Try to perform a report right away
	return doReport();
}
