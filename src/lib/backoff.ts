import { log } from '../lib/supervisor-console';
import sleep from '../lib/sleep';

/**
 * Perform exponential backoff on the function, increasing the attempts
 * counter on each call
 *
 * If attempts is 0 then, it will delay for min(minDelay, maxDelay)
 */
export const backoff = (
	retry: (attempts: number) => void,
	attempts = 0,
	maxDelay: number,
	minDelay: number,
) => {
	const delay = Math.min(2 ** attempts * minDelay, maxDelay);
	log.info(`Retrying in ${delay / 1000} seconds`);
	setTimeout(() => retry(attempts + 1), delay);
};

/**
 * Perform exponential backoff on an async function, increasing the attempts
 * counter on each call
 *
 * If attempts is 0 then, it will delay for min(minDelay, maxDelay)
 */
export async function backoffPromise(
	retry: (attempts: number) => Promise<void>,
	attempts = 0,
	maxDelay: number,
	minDelay: number,
): Promise<void> {
	const delay = Math.min(2 ** attempts * minDelay, maxDelay);
	log.info(`Retrying in ${delay / 1000} seconds`);
	await sleep(delay);
	return retry(attempts + 1);
}
