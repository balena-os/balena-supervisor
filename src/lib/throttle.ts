import { throttle as $throttle } from 'lodash';

/**
 * Creates a function for throttling a function
 *
 * throttle returns a instance of lodash's throttle with the function and wait time curried.
 * This throttle handles promise rejections better then lodash throttle by allowing
 * the caller to handle the exception.
 */
export default function throttle<T extends (...args: any[]) => Promise<void>>(
	fn: T,
	wait: number,
) {
	return $throttle(
		(
			params: Parameters<T>,
			resolve: () => void,
			reject: (e: Error) => void,
		) => {
			fn(...params)
				.then(resolve)
				.catch(reject);
		},
		wait,
	);
}
