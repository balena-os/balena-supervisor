import { setTimeout } from 'node:timers/promises';
import pTimeout from 'p-timeout';

type PredicateFunction = () => Resolvable<boolean>;
export class TimedOutError extends Error {}

/**
 * Loops for ~`maxWait` ms or `maxCount` times (`maxWait` takes precedence when provided),
 * calling the `checkFn` predicate. Returning `TRUE` from the
 * predicate will cease the looping. If `FALSE` then we delay by `delayMs` milliseconds.
 *
 * If we haven't seen a `TRUE` when the loop finishes, we throw a {@link TimedOutError}
 */
export async function waitFor({
	delayMs = 50,
	maxWait,
	maxCount = 200,
	checkFn,
}: {
	delayMs?: number;
	maxCount?: number;
	maxWait?: number;
	checkFn: PredicateFunction;
}) {
	if (maxWait != null) {
		if (delayMs > maxWait / 10) {
			// wait at least 10ms
			delayMs = Math.max(maxWait / 10, 10);
		}
		maxCount = Math.ceil(maxWait / delayMs);
	}

	let promise = (async () => {
		for (let i = 1; i <= maxCount; i++) {
			console.log(`⌚  Waiting ${delayMs}ms (${i}/${maxCount})...`);
			await setTimeout(delayMs);

			if (await checkFn()) {
				return;
			}
		}

		throw new TimedOutError();
	})();

	if (maxWait != null) {
		promise = pTimeout(promise, {
			milliseconds: maxWait,
			message: `Exceeded maxWait ${maxWait}`,
		});
	}

	await promise;
}
