import { Semaphore, E_CANCELED } from 'async-mutex';

import log from '../lib/supervisor-console';

export interface ApplyOpts {
	force: boolean;
	initial: boolean;
	abortSignal: AbortSignal;
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
	// Only trigger-initiated applies are cancellable via trigger({ cancel }).
	// withExclusive cannot be cancelled by this AbortController.
	private runningTrigger: AbortController | null = null;

	constructor(private applyFn: ApplyFn) {}

	isInProgress(): boolean {
		return this.semaphore.isLocked();
	}

	/**
	 * Queue an apply at normal priority.
	 * initial & force params are passed to the applyFn.
	 * If cancel=true, aborts the currently running trigger-initiated apply
	 * before triggering a new apply.
	 * Does not affect running or pending withExclusive calls.
	 */
	trigger({
		force = false,
		initial = false,
		cancel = false,
	}: {
		force?: boolean;
		initial?: boolean;
		cancel?: boolean;
	} = {}): void {
		if (cancel) {
			this.runningTrigger?.abort();
		}

		void this.semaphore
			.runExclusive(
				async () => {
					const ac = new AbortController();
					this.runningTrigger = ac;
					try {
						await this.applyFn({
							force,
							initial,
							abortSignal: ac.signal,
						});
					} finally {
						this.runningTrigger = null;
					}
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
	 * Not cancellable by trigger().
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
