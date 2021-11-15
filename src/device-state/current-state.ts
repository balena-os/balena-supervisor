import * as _ from 'lodash';
import * as url from 'url';
import { CoreOptions } from 'request';

import * as constants from '../lib/constants';
import { log } from '../lib/supervisor-console';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import * as sysInfo from '../lib/system-info';

import { DeviceStatus } from '../types/state';
import * as config from '../config';
import { SchemaTypeKey, SchemaReturn } from '../config/schema-type';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import { downloadProgress } from '../lib/download-progress';

// The exponential backoff starts at 15s
const MINIMUM_BACKOFF_DELAY = 15000;

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
const stateForReport: DeviceStatus = {
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
		| 'hardwareMetrics'
	>]: SchemaReturn<key>;
};

type StateReport = {
	stateDiff: DeviceStatus;
	conf: Omit<CurrentStateReportConf, 'deviceId' | 'hardwareMetrics'>;
};

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

const report = async ({ stateDiff, conf }: StateReport) => {
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
};

const getStateDiff = (): DeviceStatus => {
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
			(val, key: keyof NonNullable<DeviceStatus['local']>) =>
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
			(val, key: keyof DeviceStatus['dependent']) =>
				INTERNAL_STATE_KEYS.includes(key) ||
				_.isEqual(lastReportedDependent[key], val),
		),
	};

	return _.omitBy(diff, _.isEmpty);
};

const throttledReport = _.throttle(
	// We define the throttled function this way to avoid UncaughtPromise exceptions
	// for exceptions thrown from the report function
	(opts: StateReport, resolve: () => void, reject: (e: Error) => void) =>
		report(opts).then(resolve).catch(reject),
	constants.maxReportFrequency,
);

/**
 * Perform exponential backoff on the function, increasing the attempts
 * counter on each call
 *
 * If attempts is 0 then, it will delay for min(minDelay, maxDelay)
 */
const backoff = (
	retry: (attempts: number) => void,
	attempts = 0,
	maxDelay: number,
	minDelay = MINIMUM_BACKOFF_DELAY,
) => {
	const delay = Math.min(2 ** attempts * minDelay, maxDelay);
	log.info(`Retrying request in ${delay / 1000} seconds`);
	setTimeout(() => retry(attempts + 1), delay);
};

function reportCurrentState(attempts = 0) {
	(async () => {
		const {
			hardwareMetrics,
			appUpdatePollInterval: maxDelay,
			...conf
		} = await config.getMany([
			'deviceApiKey',
			'apiTimeout',
			'apiEndpoint',
			'uuid',
			'localMode',
			'appUpdatePollInterval',
			'hardwareMetrics',
		]);

		reportPending = true;
		const currentDeviceState = await deviceState.getStatus();
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

		stateForReport.local = {
			...stateForReport.local,
			...currentDeviceState.local,
			...info,
		};
		stateForReport.dependent = {
			...stateForReport.dependent,
			...currentDeviceState.dependent,
		};

		const stateDiff = getStateDiff();

		// report state diff
		throttledReport(
			{ stateDiff, conf },
			() => {
				// If the patch succeeds update lastReport and reset the error counter
				_.assign(lastReportedState.local, stateDiff.local);
				_.assign(lastReportedState.dependent, stateDiff.dependent);
				stateReportErrors = 0;

				reportPending = false;
			},
			(e) => {
				if (e instanceof StatusError) {
					// We don't want these errors to be classed as a report error, as this will cause
					// the watchdog to kill the supervisor - and killing the supervisor will
					// not help in this situation
					log.error(
						`Device state report failure! Status code: ${e.statusCode} - message:`,
						e.message,
					);

					// We want to backoff on all errors, but without having the healthchecks
					// get triggered.
					// This will use retryAfter as maxDelay if the header is present in the
					// response by the API
					backoff(
						reportCurrentState,
						// Do not do exponential backoff if the API reported a retryAfter
						e.retryAfter ? 0 : attempts,
						maxDelay,
						// Start the polling at the value given by the API if any
						e.retryAfter ?? MINIMUM_BACKOFF_DELAY,
					);
				} else {
					eventTracker.track('Device state report failure', {
						error: e.message,
					});
					backoff(reportCurrentState, stateReportErrors++, maxDelay);
				}
			},
		);
	})();
}

export const startReporting = () => {
	const doReport = () => {
		if (!reportPending) {
			reportCurrentState();
		}
	};

	// If the state changes, report it
	deviceState.on('change', doReport);
	// Indicate download progress via the device LED
	deviceState.on('change', downloadProgress);
	// But check once every max report frequency to ensure that changes in system
	// info are picked up (CPU temp etc)
	setInterval(doReport, constants.maxReportFrequency);
	// Try to perform a report right away
	return doReport();
};
