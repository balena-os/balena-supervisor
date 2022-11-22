import { strict as assert } from 'assert';
import { promisify } from 'util';

export type OnFailureInfo = {
	failures: number;
	delay: number;
	error: any;
};

export type Options = {
	retryCount: number;
	maxDelay: number;
	minDelay: number;
	maxRetries: number;
	onFailure?: (info: OnFailureInfo) => void;
};

const DEFAULT_OPTIONS: Partial<Options> = {
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
	options: Partial<Options> = {},
) {
	assert(typeof func === 'function', 'expected a function as parameter');
	// If the function returns a promise, unwrap the promise return type
	// otherwise use the actual return
	type TReturn = ReturnType<T> extends Promise<infer R> ? R : ReturnType<T>;

	// TODO: use standard lib async setTimeout (Node 16). Tests for backoff will fail
	// due to Sinon fake timers, so those will need to be redone too.
	const sleep = promisify(setTimeout);

	const normalizedOptions: Options = {
		...DEFAULT_OPTIONS,
		...options,
	} as Options;

	return async function wrapped(...args: Parameters<T>): Promise<TReturn> {
		try {
			return await func(...args);
		} catch (error) {
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
}

// This is the expected interface for the error type
export interface RetryError extends Error {
	retryAfter: number;
}

// Type guard only checks that retryAfter is present
const isRetryError = (x: unknown): x is RetryError =>
	x != null &&
	x instanceof Error &&
	Number.isInteger((x as RetryError).retryAfter);

/**
 * Calculates a number with exponential growth given {retryCount} within
 * a range of {minDelay} and {maxDelay} using {minDelay} as base.
 */
function exponentialRange(
	retryCount: number,
	minDelay: number,
	maxDelay: number,
): number {
	return Math.min(2 ** retryCount * minDelay, maxDelay);
}
