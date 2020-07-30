import { EventEmitter } from 'events';
import * as url from 'url';
import { delay } from 'bluebird';
import * as _ from 'lodash';
import Bluebird = require('bluebird');
import type StrictEventEmitter from 'strict-event-emitter-types';

import type { TargetState } from '../types/state';
import { InternalInconsistencyError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import { CoreOptions } from 'request';
import * as config from '../config';
import { writeLock } from '../lib/update-lock';
import constants = require('../lib/constants');
import log from '../lib/supervisor-console';

export class ApiResponseError extends Error {}

interface TargetStateEvents {
	'target-state-update': (
		targetState: TargetState,
		force: boolean,
		isFromApi: boolean,
	) => void;
}
export const emitter: StrictEventEmitter<
	EventEmitter,
	TargetStateEvents
> = new EventEmitter();

const lockGetTarget = () =>
	writeLock('getTarget').disposer((release) => release());

let cache: {
	etag?: string | string[];
	body: TargetState;
};

/**
 * appUpdatePollInterval is set when startPoll successfuly queries the config
 */
let appUpdatePollInterval: number;

/**
 * Listen for config changes to appUpdatePollInterval
 */
(async () => {
	await config.initialized;
	config.on('change', (changedConfig) => {
		if (changedConfig.appUpdatePollInterval) {
			appUpdatePollInterval = changedConfig.appUpdatePollInterval;
		}
	});
})();

/**
 * The last fetch attempt
 *
 * We set a value rather then being undeclared because having it undefined
 * adds more overhead to dealing with this value without any benefits.
 */
export let lastFetch: ReturnType<typeof process.hrtime> = process.hrtime();

/**
 * Attempts to update the target state
 * @param force Emitted with the 'target-state-update' event update as necessary
 * @param isFromApi Emitted with the 'target-state-update' event update as necessary
 */
export const update = async (
	// TODO: Is there a better way than passing these params here just to emit them if there is an update?
	force = false,
	isFromApi = false,
): Promise<void> => {
	await config.initialized;
	return Bluebird.using(lockGetTarget(), async () => {
		const {
			uuid,
			apiEndpoint,
			apiTimeout,
			deviceApiKey,
		} = await config.getMany([
			'uuid',
			'apiEndpoint',
			'apiTimeout',
			'deviceApiKey',
		]);

		if (typeof apiEndpoint !== 'string') {
			throw new InternalInconsistencyError(
				'Non-string apiEndpoint passed to ApiBinder.getTargetState',
			);
		}

		const endpoint = url.resolve(apiEndpoint, `/device/v2/${uuid}/state`);
		const request = await getRequestInstance();

		const params: CoreOptions = {
			json: true,
			headers: {
				Authorization: `Bearer ${deviceApiKey}`,
				'If-None-Match': cache?.etag,
			},
		};

		const [{ statusCode, headers }, body] = await request
			.getAsync(endpoint, params)
			.timeout(apiTimeout);

		if (statusCode === 304) {
			// There's no change so no need to update the cache or emit a change event
			return;
		}

		if (statusCode < 200 || statusCode >= 300) {
			log.error(`Error from the API: ${statusCode}`);
			throw new ApiResponseError(`Error from the API: ${statusCode}`);
		}

		cache = {
			etag: headers.etag,
			body,
		};

		emitter.emit('target-state-update', _.cloneDeep(body), force, isFromApi);
	}).finally(() => {
		lastFetch = process.hrtime();
	});
};

const poll = async (
	skipFirstGet: boolean = false,
	fetchErrors: number = 0,
): Promise<void> => {
	// Add random jitter up to `maxApiJitterDelay` to space out poll requests
	let pollInterval =
		Math.random() * constants.maxApiJitterDelay + appUpdatePollInterval;

	// Convenience function used for delaying poll loops
	const delayedLoop = async (delayBy: number) => {
		// Wait until we want to poll again
		await delay(delayBy);
		// Poll again
		await poll(false, fetchErrors);
	};

	// Check if we want to skip first request and just loop again
	if (skipFirstGet) {
		return delayedLoop(pollInterval);
	}

	// Try to fetch latest target state
	try {
		await update();
		// Reset fetchErrors because we successfuly updated
		fetchErrors = 0;
	} catch (e) {
		// Exponential back off if request fails
		pollInterval = Math.min(appUpdatePollInterval, 15000 * 2 ** fetchErrors);
		++fetchErrors;
	} finally {
		// Wait to poll again
		await delayedLoop(pollInterval);
	}
};

/**
 * Checks for target state changes and then returns the latest target state
 */
export const get = async (): Promise<TargetState> => {
	await update();
	return _.cloneDeep(cache.body);
};

/**
 * Start polling for target state updates
 *
 * startPoll will try to query the config for all values needed
 * to being polling. If there is an issue obtaining these values
 * the function will wait 10 seconds and retry until successful.
 */
export const startPoll = async (): Promise<void> => {
	let instantUpdates;
	try {
		// Query and set config values we need to avoid multiple db hits
		const {
			instantUpdates: updates,
			appUpdatePollInterval: interval,
		} = await config.getMany(['instantUpdates', 'appUpdatePollInterval']);
		instantUpdates = updates;
		appUpdatePollInterval = interval;
	} catch {
		// Delay 10 seconds and retry loading config
		await delay(10000);
		// Attempt to start poll again
		return startPoll();
	}
	// All config values fetch, start polling!
	return poll(!instantUpdates);
};
