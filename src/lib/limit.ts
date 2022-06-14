import { strict as assert } from 'assert';
import { promisify } from 'util';
import { TypedError } from 'typed-error';
import pThrottle = require('p-throttle');

/**
 * Generic error thrown when something does not want to be retried/delayed.
 * This can be things like a backoff or throttle.
 */
export class AbortLimit extends TypedError {}

export type ThrottleOptions = {
	limit: number;
};

const DEFAULT_THROTTLE_OPTIONS: Partial<ThrottleOptions> = {
	limit: 1,
};

/**
 * Ensures a function is only invoked by default once every N seconds.
 *
 * If the func passed throws AbortLimit all queued calls are rejected.
 * Passing an options with limit greater than 1 means the function can
 * have parallel calls in progress.
 */
export function withThrottle<T extends (...args: any[]) => any>(
	func: T,
	wait: number,
	options: Partial<ThrottleOptions> = {},
) {
	assert(typeof func === 'function', 'expected a function as parameter');
	// If the function returns a promise, unwrap the promise return type
	// otherwise use the actual return
	type TReturn = ReturnType<T> extends Promise<infer R> ? R : ReturnType<T>;

	const normalizedOptions: ThrottleOptions = {
		...DEFAULT_THROTTLE_OPTIONS,
		...options,
	} as ThrottleOptions;

	const throttledFunc = pThrottle({
		limit: normalizedOptions.limit,
		interval: wait,
	})(func);

	return async function wrapped(...args: Parameters<T>): Promise<TReturn> {
		try {
			return await throttledFunc(...args);
		} catch (e) {
			if (e instanceof AbortLimit) {
				// Remove any queued throttles so the next call happens right away!
				throttledFunc.abort();
			}
			// This will be the exception thrown by func
			throw e;
		}
	};
}

export type OnRetry = {
	failures: number;
	delay: number;
	error: any;
};

export type BackoffOptions = {
	retryCount: number;
	maxDelay: number;
	minDelay: number;
	maxRetries: number;
	onFailure?: (info: OnRetry) => void;
};

const DEFAULT_BACKOFF_OPTIONS: Partial<BackoffOptions> = {
	retryCount: 0,
	maxDelay: 15000,
	minDelay: 15000,
	maxRetries: Infinity,
};

/**
 * Retries a function with exponential delay between calls.
 * If attempts is 0 then, it will delay for min(minDelay, maxDelay)
 *
 * Supports exceptions which return `retryAfter` value to specify the backoff duration.
 * Will call `retryCallback` if passed in options as a way for callers to react to retries
 */
export function withBackoff<T extends (...args: any[]) => any>(
	func: T,
	options: Partial<BackoffOptions> = {},
) {
	assert(typeof func === 'function', 'expected a function as parameter');
	// If the function returns a promise, unwrap the promise return type
	// otherwise use the actual return
	type TReturn = ReturnType<T> extends Promise<infer R> ? R : ReturnType<T>;

	// TODO use standard lib async setTimout (requires node 16)
	const sleep = promisify(setTimeout);

	// Type guard only checks that retryAfter is present
	const isRetryError = (x: unknown): x is RetryError =>
		x != null &&
		x instanceof Error &&
		Number.isInteger((x as RetryError).retryAfter);

	const normalizedOptions: BackoffOptions = {
		...DEFAULT_BACKOFF_OPTIONS,
		...options,
	} as BackoffOptions;

	return async function wrapped(...args: Parameters<T>): Promise<TReturn> {
		try {
			return await func(...args);
		} catch (error) {
			if (error instanceof AbortLimit) {
				// Propogate this error because the wrapped function does not want to be limited
				throw error;
			}

			if (normalizedOptions.retryCount >= normalizedOptions.maxRetries) {
				throw new Error(
					`Reached max number of retries: ${normalizedOptions.maxRetries}`,
				);
			}

			const wait = isRetryError(error)
				? error.retryAfter
				: exponentialRange(
						normalizedOptions.retryCount,
						normalizedOptions.minDelay,
						normalizedOptions.maxDelay,
				  );

			normalizedOptions.retryCount++;

			if (normalizedOptions.onFailure) {
				normalizedOptions.onFailure({
					failures: normalizedOptions.retryCount,
					delay: wait,
					error,
				});
			}

			await sleep(wait);

			return wrapped(...args);
		}
	};

	// Calculates a number with exponential growth given {retryCount} within
	// a range of {minDelay} and {maxDelay} using {minDelay} as base.
	function exponentialRange(
		retryCount: number,
		minDelay: number,
		maxDelay: number,
	): number {
		return Math.min(2 ** retryCount * minDelay, maxDelay);
	}

	interface RetryError extends Error {
		retryAfter: number;
	}
}
