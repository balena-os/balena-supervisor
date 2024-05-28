import { EventEmitter } from 'events';
import url from 'url';
import { setTimeout } from 'timers/promises';
import Bluebird from 'bluebird';
import type StrictEventEmitter from 'strict-event-emitter-types';

import type { TargetState } from '../types/state';
import { InternalInconsistencyError } from '../lib/errors';
import { getGotInstance } from '../lib/request';
import * as config from '../config';
import { takeGlobalLockRW } from '../lib/process-lock';
import * as constants from '../lib/constants';
import log from '../lib/supervisor-console';

export class ApiResponseError extends Error {}

interface TargetStateEvents {
	'target-state-update': (
		targetState: TargetState,
		force: boolean,
		isFromApi: boolean,
	) => void;
	'target-state-apply': (force: boolean, isFromApi: boolean) => void;
}
export const emitter: StrictEventEmitter<EventEmitter, TargetStateEvents> =
	new EventEmitter();

const lockGetTarget = () =>
	takeGlobalLockRW('getTarget').disposer((release) => release());

type CachedResponse = {
	etag?: string | string[];
	body: TargetState;
	emitted?: boolean;
};

let cache: CachedResponse;

/**
 * appUpdatePollInterval is set when startPoll successfuly queries the config
 */
let appUpdatePollInterval: number;

/**
 * Emit target state event based on if the CacheResponse has/was emitted.
 *
 * Returns false if the CacheResponse is not emitted.
 *
 * @param cachedResponse the response to emit
 * @param force Emitted with the 'target-state-update' event update as necessary
 * @param isFromApi Emitted with the 'target-state-update' event update as necessary
 * @return true if the response has been emitted or false otherwise
 */
const emitTargetState = (
	cachedResponse: CachedResponse,
	force = false,
	isFromApi = false,
): boolean => {
	if (
		!cachedResponse.emitted &&
		emitter.listenerCount('target-state-update') > 0
	) {
		// CachedResponse has not been emitted before so emit as an update
		emitter.emit(
			'target-state-update',
			structuredClone(cachedResponse.body),
			force,
			isFromApi,
		);
		return true;
	} else if (
		cachedResponse.emitted &&
		isFromApi &&
		emitter.listenerCount('target-state-apply') > 0
	) {
		// CachedResponse has been emitted but a client triggered the check so emit an apply
		emitter.emit('target-state-apply', force, isFromApi);
		return true;
	}
	// Return the same emitted value but normalized to be a boolean
	return !!cache.emitted;
};

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
	await config.initialized();
	return Bluebird.using(lockGetTarget(), async () => {
		const { uuid, apiEndpoint, apiTimeout, deviceApiKey } =
			await config.getMany([
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

		const endpoint = url.resolve(apiEndpoint, `/device/v3/${uuid}/state`);
		const got = await getGotInstance();

		const { statusCode, headers, body } = await got(endpoint, {
			headers: {
				Authorization: `Bearer ${deviceApiKey}`,
				'If-None-Match': cache?.etag,
			},
			timeout: {
				// TODO: We use the same default timeout for all of these in order to have a timeout generally
				// but it would probably make sense to tune them individually
				lookup: apiTimeout,
				connect: apiTimeout,
				secureConnect: apiTimeout,
				socket: apiTimeout,
				send: apiTimeout,
				response: apiTimeout,
			},
		});

		if (statusCode === 304 && cache?.etag != null) {
			// There's no change so no need to update the cache
			// only emit the target state if it hasn't been emitted yet
			cache.emitted = emitTargetState(cache, force, isFromApi);
			return;
		}

		if (statusCode < 200 || statusCode >= 300) {
			log.error(`Error from the API: ${statusCode}`);
			throw new ApiResponseError(`Error from the API: ${statusCode}`);
		}

		cache = {
			etag: headers.etag,
			body: body as any,
		};

		// Emit the target state and update the cache
		cache.emitted = emitTargetState(cache, force, isFromApi);
	}).finally(() => {
		lastFetch = process.hrtime();
	});
};

const poll = async (
	skipFirstGet: boolean = false,
	fetchErrors: number = 0,
): Promise<void> => {
	// Add random jitter up to `maxApiJitterDelay` to space out poll requests
	// NOTE: the jitter has as objective to reduce the load on networks that have
	// devices on the 1000s. It's not meant to ease the load on the API as the backend performs
	// other operations to deal with scaling issues
	let pollInterval =
		Math.random() * constants.maxApiJitterDelay + appUpdatePollInterval;

	// Convenience function used for delaying poll loops
	const delayedLoop = async (delayBy: number) => {
		// Wait until we want to poll again
		await setTimeout(delayBy);
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
	} catch {
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
	return structuredClone(cache.body);
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
		await config.initialized();

		/**
		 * Listen for config changes to appUpdatePollInterval
		 */
		config.on('change', (changedConfig) => {
			if (changedConfig.appUpdatePollInterval) {
				appUpdatePollInterval = changedConfig.appUpdatePollInterval;
			}
		});

		// Query and set config values we need to avoid multiple db hits
		const { instantUpdates: updates, appUpdatePollInterval: interval } =
			await config.getMany(['instantUpdates', 'appUpdatePollInterval']);
		instantUpdates = updates;
		appUpdatePollInterval = interval;
	} catch {
		// Delay 10 seconds and retry loading config
		await setTimeout(10000);
		// Attempt to start poll again
		return startPoll();
	}
	// All config values fetch, start polling!
	return poll(!instantUpdates);
};
