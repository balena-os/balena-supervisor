import { Semaphore, E_CANCELED } from 'async-mutex';

import log from '../lib/supervisor-console';

export { E_CANCELED };

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
	// Only trigger-initiated calls are cancellable via trigger({ cancel }).
	// withExclusive cannot be cancelled by this AbortController.
	private runningTrigger: AbortController | null = null;
	// This AbortController is used to cancel in-flight withExclusive calls.
	private runningExclusive: AbortController | null = null;
	// Cancellation token for pending (queued but not yet running) triggers.
	// When cancel is requested, the current controller is aborted and replaced,
	// so any previously queued triggers see an aborted signal and skip execution.
	private pendingTriggers = new AbortController();

	constructor(
		private fn: (opts: FnArgs & { abortSignal: AbortSignal }) => Promise<void>,
	) {}

	isInProgress(): boolean {
		return this.semaphore.isLocked();
	}

	/**
	 * Queue fn at normal priority.
	 * FnArgs fields are passed through to fn.
	 * If cancel=true, aborts the currently running trigger-initiated call
	 * and invalidates all pending trigger callbacks before triggering a new call.
	 * Does not affect running or pending withExclusive calls.
	 */
	trigger(
		opts: FnArgs & { cancel?: boolean } = {} as FnArgs & { cancel?: boolean },
	): void {
		const { cancel: _, ...fnArgs } = opts;
		if (opts.cancel) {
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
						await this.fn({
							...(fnArgs as FnArgs),
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
	 * Provides an AbortSignal to the callback. Not cancellable by trigger().
	 *
	 * Aborts the currently running trigger or exclusive,
	 * invalidates all pending triggers, and rejects all pending waiters
	 * (both trigger and exclusive) with E_CANCELED.
	 */
	async withExclusive(
		fn: (abortSignal: AbortSignal) => Promise<void>,
	): Promise<void> {
		this.runningTrigger?.abort();
		this.runningExclusive?.abort();
		this.pendingTriggers.abort();
		this.pendingTriggers = new AbortController();
		this.semaphore.cancel();

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
