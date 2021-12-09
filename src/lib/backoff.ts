type BackoffOpts = {
	retry: (attempts: number) => void;
	maxDelay?: number;
	minDelay?: number;
	attempts?: number;
	onRetry?: (delay: number, attempts: number) => void;
};

/**
 * Perform exponential backoff on the function, increasing the attempts
 * counter on each call
 *
 * If attempts is 0 then, it will delay for min(minDelay, maxDelay)
 */
export function backoff({
	retry,
	maxDelay = 0,
	minDelay = maxDelay,
	attempts = 0,
	onRetry = () => void 0,
}: BackoffOpts) {
	const delay = Math.min(2 ** attempts * minDelay, maxDelay);
	onRetry(delay, attempts);
	setTimeout(() => retry(attempts + 1), delay);
}
