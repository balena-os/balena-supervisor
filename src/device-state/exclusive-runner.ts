import { Semaphore, E_CANCELED } from 'async-mutex';

import log from '../lib/supervisor-console';

export const NORMAL_PRIORITY = 0;
export const HIGH_PRIORITY = 1;

/**
 * INVARIANTS:
 * - Only trigger fn through ExclusiveRunner methods.
 * - fn should handle its own errors. If it does throw, the unhandled error is logged and
 *   the semaphore is released so subsequent calls can run.
 * - Do NOT call withExclusive() from within fn, because trigger() holds the semaphore
 *   and withExclusive waits for the semaphore to be released, which would result in a deadlock.
 * - Do NOT nest calls to withExclusive(), as it will result in a deadlock.
 */
export class ExclusiveRunner<
	FnArgs extends Record<string, unknown> = Record<string, unknown>,
> {
	private semaphore = new Semaphore(1);

	constructor(private fn: (opts: FnArgs) => Promise<void>) {}

	isInProgress(): boolean {
		return this.semaphore.isLocked();
	}

	/**
	 * Queue fn at normal priority.
	 * FnArgs fields are passed through to fn.
	 */
	trigger(opts: FnArgs = {} as FnArgs): void {
		void this.semaphore
			.runExclusive(
				async () => {
					await this.fn(opts);
				},
				1,
				NORMAL_PRIORITY,
			)
			.catch((err) => {
				if (err !== E_CANCELED) {
					// trigger() is fire-and-forget, so fn is responsible for its own error handling.
					log.error(
						`Unhandled error thrown from ${this.fn.name ?? 'fn'}: ${err.message ?? err}`,
					);
				}
			});
	}

	/**
	 * Run an awaitable callback exclusively at high priority.
	 * Used for high priority sequences which execute before normal triggers.
	 * "High priority sequences" include user actions such as restart or purge.
	 */
	async withExclusive(fn: () => Promise<void>): Promise<void> {
		return this.semaphore.runExclusive(
			async () => {
				await fn();
			},
			1,
			HIGH_PRIORITY,
		);
	}
}
