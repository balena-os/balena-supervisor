import { Semaphore, E_CANCELED } from 'async-mutex';

import log from '../lib/supervisor-console';

export interface ApplyOpts {
	force: boolean;
	initial: boolean;
}

type ApplyFn = (opts: ApplyOpts) => Promise<void>;

export const NORMAL_PRIORITY = 0;
export const HIGH_PRIORITY = 1;

/**
 * INVARIANTS:
 * - Only trigger applyFn through StateApplicator methods.
 * - applyFn should handle its own errors. If it does throw, the unhandled error is logged and
 *   the semaphore is released so subsequent applies can run.
 * - Do NOT call withExclusive() from within applyFn, because trigger() holds the semaphore
 *   and withExclusive waits for the semaphore to be released, which would result in a deadlock.
 * - Do NOT nest calls to withExclusive(), as it will result in a deadlock.
 */
export class StateApplicator {
	private semaphore = new Semaphore(1);

	constructor(private applyFn: ApplyFn) {}

	isInProgress(): boolean {
		return this.semaphore.isLocked();
	}

	/**
	 * Queue an apply at normal priority.
	 * initial & force params are passed to the applyFn.
	 */
	trigger({
		force = false,
		initial = false,
	}: {
		force?: boolean;
		initial?: boolean;
	} = {}): void {
		void this.semaphore
			.runExclusive(
				async () => {
					await this.applyFn({
						force,
						initial,
					});
				},
				1,
				NORMAL_PRIORITY,
			)
			.catch((err) => {
				if (err !== E_CANCELED) {
					// trigger() is fire-and-forget, so applyFn is responsible for its own error handling.
					log.error(
						`Unhandled error thrown from ${this.applyFn.name ?? 'applyFn'}: ${err.message ?? err}`,
					);
				}
			});
	}

	/**
	 * Run an awaitable callback exclusively at high priority.
	 * Used for high priority sequences which execute before normal apply.
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
