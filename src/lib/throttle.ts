import { strict as assert } from 'assert';
import { performance } from 'perf_hooks';

export interface Options {
	throttleOn: ((...args: any[]) => boolean) | null;
}

const DEFAULT_OPTIONS: Partial<Options> = {
	throttleOn: null,
};

export function throttle<T extends (...args: any[]) => any>(
	func: T,
	delay: number,
	options: Partial<Options> = {},
) {
	assert(typeof func === 'function', 'expected a function as parameter');
	// If the function returns a promise, unwrap the promise return type
	// otherwise use the actual return
	type TReturn = ReturnType<T> extends Promise<infer R> ? R : ReturnType<T>;

	const normalizedOptions: Options = {
		...DEFAULT_OPTIONS,
		...options,
	} as Options;

	let lastReportTime: number = -Infinity;
	let cachedReturn: TReturn;

	return async function wrapped(...args: Parameters<T>): Promise<TReturn> {
		const now = performance.now();
		// Only call func if enough time has elapsed since the last time we called it
		if (now - lastReportTime >= delay) {
			cachedReturn = await func(...args);
			lastReportTime = now;
			return cachedReturn;
		} else {
			return cachedReturn;
		}
		// TODO: add a way to defer calls.... leading/trailing options
	};
}
