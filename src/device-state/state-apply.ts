import { Semaphore, E_CANCELED } from 'async-mutex';

import log from '../lib/supervisor-console';

export { E_CANCELED };

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
	// This AbortController is used to cancel in-flight withExclusive calls.
	private runningExclusive: AbortController | null = null;
	// Cancellation token for pending (queued but not yet running) triggers.
	// When cancel is requested, the current controller is aborted and replaced,
	// so any previously queued triggers see an aborted signal and skip execution.
	private pendingTriggers = new AbortController();

	constructor(private applyFn: ApplyFn) {}

	isInProgress(): boolean {
		return this.semaphore.isLocked();
	}

	/**
	 * Queue an apply at normal priority.
	 * initial & force params are passed to the applyFn.
	 * If cancel=true, aborts the currently running trigger-initiated apply
	 * and invalidates all pending trigger callbacks before triggering a new apply.
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
			this.pendingTriggers.abort();
			this.pendingTriggers = new AbortController();
		}

		// This captures the signal at call time so that the correct aborted
		// pending signal is checked accurately in old trigger calls.
		const { signal: pendingSignal } = this.pendingTriggers;

		void this.semaphore
			.runExclusive(
				async () => {
					// Skip if a cancel has invalidated this queued trigger.
					if (pendingSignal.aborted) {
						return;
					}
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
	 * Provides an AbortSignal to the callback. Not cancellable by trigger().
	 *
	 * If cancel=true, aborts the currently running trigger or exclusive,
	 * invalidates all pending triggers, and rejects all pending waiters
	 * (both trigger and exclusive) with E_CANCELED.
	 */
	async withExclusive(
		fn: (abortSignal: AbortSignal) => Promise<void>,
		{ cancel = false }: { cancel?: boolean } = {},
	): Promise<void> {
		if (cancel) {
			this.runningTrigger?.abort();
			this.runningExclusive?.abort();
			this.pendingTriggers.abort();
			this.pendingTriggers = new AbortController();
			this.semaphore.cancel();
		}

		const ac = new AbortController();
		return this.semaphore.runExclusive(
			async () => {
				this.runningExclusive = ac;
				try {
					await fn(ac.signal);
				} catch (err) {
					ac.abort();
					throw err;
				} finally {
					this.runningExclusive = null;
				}
			},
			1,
			HIGH_PRIORITY,
		);
	}
}
