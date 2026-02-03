import { expect } from 'chai';
import { setTimeout } from 'timers/promises';
import type { SinonStub } from 'sinon';

import {
	ExclusiveRunner,
	E_CANCELED,
} from '~/src/device-state/exclusive-runner';
import log from '~/lib/supervisor-console';

// Create a deferred promise that can be resolved externally.
function deferred() {
	let resolve!: () => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Wait for all pending microtasks/timers to flush.
const tick = (ms = 10) => setTimeout(ms);

describe('ExclusiveRunner', () => {
	describe('trigger', () => {
		it('calls fn with the provided options', async () => {
			let receivedOpts: any = null;
			const runner = new ExclusiveRunner<{
				force?: boolean;
				initial?: boolean;
			}>(async (opts) => {
				receivedOpts = opts;
				await Promise.resolve();
			});

			runner.trigger({ force: true, initial: true });
			await tick();

			expect(receivedOpts).to.have.property('force', true);
			expect(receivedOpts).to.have.property('initial', true);
			expect(receivedOpts)
				.to.have.property('abortSignal')
				.that.is.instanceof(AbortSignal);
		});

		it('passes an empty object to fn when called with no args', async () => {
			let receivedOpts: any = null;
			const runner = new ExclusiveRunner(async (opts) => {
				receivedOpts = opts;
				await Promise.resolve();
			});

			runner.trigger();
			await tick();

			expect(receivedOpts)
				.to.have.property('abortSignal')
				.that.is.instanceof(AbortSignal);
		});

		it('logs an unhandled error when fn throws, because fn should handle its own errors', async () => {
			const runner = new ExclusiveRunner(async function myFn() {
				await Promise.resolve();
				throw new Error('unhandled error');
			});

			runner.trigger();
			await tick();
			expect(log.error as SinonStub).to.have.been.calledWith(
				'Unhandled error thrown from myFn: unhandled error',
			);
		});

		it('releases the semaphore after fn throws so subsequent calls can run', async () => {
			let callCount = 0;
			const runner = new ExclusiveRunner(async () => {
				if (++callCount === 1) {
					throw new Error('first call fails');
				}
				await Promise.resolve();
			});

			runner.trigger();
			await tick();
			expect(callCount).to.equal(1);

			// Second trigger should still run
			runner.trigger();
			await tick();
			expect(callCount).to.equal(2);
		});
	});

	describe('withExclusive', () => {
		it('is not affected by a normal trigger with cancel=true', async () => {
			let exclusiveRan = false;
			const barrier = deferred();

			const runner = new ExclusiveRunner(async () => {
				await Promise.resolve();
			});

			const exclusiveDone = runner.withExclusive(async () => {
				await barrier.promise;
				exclusiveRan = true;
			});
			await tick();

			// A normal trigger with cancel should not affect the exclusive call
			runner.trigger({ cancel: true });
			await tick();

			barrier.resolve();
			await exclusiveDone;

			expect(exclusiveRan).to.be.true;
		});

		it('holds the lock for the entire callback', async () => {
			const order: string[] = [];
			const runner = new ExclusiveRunner(async () => {
				order.push('normal');
				await Promise.resolve();
			});

			// Start an exclusive sequence
			const exclusiveDone = runner.withExclusive(async () => {
				order.push('exclusive-step-1');
				await tick(20);
				order.push('exclusive-step-2');
				await tick(20);
				order.push('exclusive-step-3');
			});

			// Queue a normal trigger during the exclusive hold
			runner.trigger();

			await exclusiveDone;
			await tick();

			// Normal should only run after all exclusive steps complete
			expect(order).to.deep.equal([
				'exclusive-step-1',
				'exclusive-step-2',
				'exclusive-step-3',
				'normal',
			]);
		});

		it('returns a promise that resolves when callback completes', async () => {
			let completed = false;
			const runner = new ExclusiveRunner(async () => {
				await Promise.resolve();
			});

			await runner.withExclusive(async () => {
				await tick(20);
				completed = true;
			});

			expect(completed).to.be.true;
		});

		it('releases the semaphore after error so subsequent calls can run', async () => {
			let normalRan = false;
			const runner = new ExclusiveRunner(async () => {
				normalRan = true;
				await Promise.resolve();
			});

			try {
				await runner.withExclusive(async () => {
					await Promise.resolve();
					throw new Error('fail');
				});
			} catch {
				// expected
			}

			runner.trigger();
			await tick();

			expect(normalRan).to.be.true;
		});
	});

	describe('mutual exclusion', () => {
		it('runs only one call at a time', async () => {
			let running = 0;
			let maxRunning = 0;
			let callIndex = 0;
			const barriers = [deferred(), deferred(), deferred()];

			const runner = new ExclusiveRunner(async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await barriers[callIndex++].promise;
				running--;
			});

			runner.trigger();
			runner.trigger();
			runner.trigger();

			await tick();
			expect([running, maxRunning]).to.deep.equal([1, 1]);

			// Release first call
			barriers[0].resolve();
			await tick();
			expect([running, maxRunning]).to.deep.equal([1, 1]);

			// Release second call
			barriers[1].resolve();
			await tick();
			expect([running, maxRunning]).to.deep.equal([1, 1]);

			// Release third call
			barriers[2].resolve();
			await tick();
			expect([running, maxRunning]).to.deep.equal([0, 1]);
		});

		it('isInProgress returns true while fn is running', async () => {
			const barrier = deferred();
			const runner = new ExclusiveRunner(async () => {
				await barrier.promise;
			});

			expect(runner.isInProgress()).to.be.false;

			runner.trigger();
			await tick();
			expect(runner.isInProgress()).to.be.true;

			barrier.resolve();
			await tick();
			expect(runner.isInProgress()).to.be.false;
		});

		it('isInProgress returns true while withExclusive is running', async () => {
			const barrier = deferred();
			const runner = new ExclusiveRunner(async () => {
				await Promise.resolve();
			});

			expect(runner.isInProgress()).to.be.false;

			const exclusiveDone = runner.withExclusive(async () => {
				await barrier.promise;
			});
			await tick();
			expect(runner.isInProgress()).to.be.true;

			barrier.resolve();
			await exclusiveDone;
			expect(runner.isInProgress()).to.be.false;
		});
	});

	describe('priority', () => {
		it('withExclusive cancels pending triggers and runs at high priority', async () => {
			const order: string[] = [];
			const initialBarrier = deferred();

			const runner = new ExclusiveRunner(async () => {
				order.push('normal');
				await Promise.resolve();
			});

			// Start an exclusive that holds the semaphore
			const holdingSemaphore = runner.withExclusive(async () => {
				order.push('holding');
				await initialBarrier.promise;
			});
			await tick();

			// Queue a normal trigger
			runner.trigger();

			// withExclusive cancels the pending trigger and queues at high priority
			const ex = runner.withExclusive(async () => {
				order.push('exclusive');
				await Promise.resolve();
			});

			// Queue another normal trigger after the exclusive
			runner.trigger();

			// Release the initial holder
			initialBarrier.resolve();
			await holdingSemaphore.catch(() => {
				// expected: may be cancelled
			});
			await ex;
			await tick();

			// The pre-cancel trigger was invalidated; exclusive ran first,
			// then the post-cancel trigger
			expect(order).to.deep.equal(['holding', 'exclusive', 'normal']);
		});
	});

	describe('cancellation', () => {
		it('cancel with nothing running still queues a call', async () => {
			let called = false;
			const runner = new ExclusiveRunner(async () => {
				called = true;
				await Promise.resolve();
			});

			runner.trigger({ cancel: true });
			await tick();

			expect(called).to.be.true;
		});

		it('aborts the running call when cancel=true', async () => {
			let aborted = false;
			const barrier = deferred();
			const runner = new ExclusiveRunner(async ({ abortSignal }) => {
				abortSignal.addEventListener('abort', () => {
					aborted = true;
				});
				await barrier.promise;
			});

			runner.trigger();
			await tick();
			expect(aborted).to.be.false;

			runner.trigger({ cancel: true });
			await tick();
			expect(aborted).to.be.true;

			barrier.resolve();
			await tick();
		});

		it('runs the new call after the cancelled one finishes', async () => {
			const calls: number[] = [];
			let callCount = 0;
			const barriers = [deferred(), deferred()];

			const runner = new ExclusiveRunner(async ({ abortSignal }) => {
				const count = callCount++;
				calls.push(count);
				if (count === 0) {
					// First call: wait until aborted, then exit
					await new Promise<void>((resolve) => {
						abortSignal.addEventListener('abort', () => {
							resolve();
						});
					});
				} else {
					await barriers[1].promise;
				}
			});

			runner.trigger();
			await tick();
			expect(calls).to.deep.equal([0]);

			// Cancel and dispatch new call
			runner.trigger({ cancel: true });
			await tick(50);
			expect(calls).to.deep.equal([0, 1]);

			barriers[1].resolve();
			await tick();
		});
	});

	describe('pending call cancellation', () => {
		it('trigger({ cancel }) skips previously queued pending triggers', async () => {
			const calls: number[] = [];
			let callIndex = 0;
			const barrier = deferred();

			const runner = new ExclusiveRunner(async () => {
				calls.push(callIndex++);
				if (calls.length === 1) {
					await barrier.promise;
				}
				await Promise.resolve();
			});

			// First trigger starts running and blocks
			runner.trigger();
			await tick();
			expect(calls).to.deep.equal([0]);

			// Queue two more triggers
			runner.trigger();
			runner.trigger();

			// Cancel: aborts running + invalidates the two queued triggers
			runner.trigger({ cancel: true });

			// Release the first call
			barrier.resolve();
			await tick(50);

			// Only the first (running) and the cancel trigger should have run.
			// The two intermediate queued triggers should have been skipped.
			expect(calls).to.deep.equal([0, 1]);
		});

		it('trigger({ cancel }) does not prevent a subsequent withExclusive from running', async () => {
			const order: string[] = [];
			const barrier = deferred();

			const runner = new ExclusiveRunner(async () => {
				order.push('normal');
				await Promise.resolve();
			});

			// Hold the semaphore
			const holdDone = runner.withExclusive(async () => {
				order.push('holding');
				await barrier.promise;
			});
			await tick();

			// Queue a normal trigger, then cancel it
			runner.trigger();
			runner.trigger({ cancel: true });

			// Queue an exclusive after the trigger cancel
			const exDone = runner.withExclusive(async () => {
				order.push('exclusive');
				await Promise.resolve();
			});

			// Release the holder
			barrier.resolve();
			await holdDone.catch(() => {
				// expected: may be cancelled
			});
			await exDone;
			await tick();

			// The exclusive should still run after trigger cancel
			expect(order[0]).to.equal('holding');
			expect(order[1]).to.equal('exclusive');
		});

		it('withExclusive aborts the running trigger', async () => {
			let triggerAborted = false;
			const barrier = deferred();

			const runner = new ExclusiveRunner(async ({ abortSignal }) => {
				abortSignal.addEventListener('abort', () => {
					triggerAborted = true;
				});
				await barrier.promise;
			});

			runner.trigger();
			await tick();
			expect(triggerAborted).to.be.false;

			const exDone = runner.withExclusive(async () => {
				await Promise.resolve();
			});

			barrier.resolve();
			await exDone;

			expect(triggerAborted).to.be.true;
		});

		it('withExclusive aborts a running exclusive', async () => {
			let firstExAborted = false;
			const barrier = deferred();

			const runner = new ExclusiveRunner(async () => {
				await Promise.resolve();
			});

			const firstEx = runner
				.withExclusive(async (abortSignal) => {
					abortSignal.addEventListener('abort', () => {
						firstExAborted = true;
					});
					await barrier.promise;
				})
				.catch(() => {
					// expected: cancelled by subsequent withExclusive
				});
			await tick();
			expect(firstExAborted).to.be.false;

			const secondEx = runner.withExclusive(async () => {
				await Promise.resolve();
			});

			barrier.resolve();
			await firstEx;
			await secondEx;

			expect(firstExAborted).to.be.true;
		});

		it('withExclusive rejects all pending waiters with E_CANCELED', async () => {
			const barrier = deferred();
			const errors: unknown[] = [];

			const runner = new ExclusiveRunner(async () => {
				await Promise.resolve();
			});

			// Hold the semaphore
			const holdDone = runner.withExclusive(async () => {
				await barrier.promise;
			});
			await tick();

			// Queue pending exclusive waiters — each cancels the previous
			const ex1 = runner
				.withExclusive(async () => {
					await Promise.resolve();
				})
				.catch((err) => {
					errors.push(err);
				});
			const ex2 = runner
				.withExclusive(async () => {
					await Promise.resolve();
				})
				.catch((err) => {
					errors.push(err);
				});

			const cancelEx = runner.withExclusive(async () => {
				await Promise.resolve();
			});

			barrier.resolve();
			await holdDone.catch(() => {
				// expected: may be cancelled
			});
			await ex1;
			await ex2;
			await cancelEx;

			// ex1 and ex2 should have been rejected with E_CANCELED
			// by subsequent withExclusive calls
			expect(errors).to.have.lengthOf(2);
			expect(errors[0]).to.equal(E_CANCELED);
			expect(errors[1]).to.equal(E_CANCELED);
		});

		it('withExclusive invalidates pending triggers', async () => {
			const order: string[] = [];
			const barrier = deferred();

			const runner = new ExclusiveRunner(async () => {
				order.push('normal');
				await Promise.resolve();
			});

			// Hold the semaphore
			const holdDone = runner.withExclusive(async () => {
				order.push('holding');
				await barrier.promise;
			});
			await tick();

			// Queue normal triggers
			runner.trigger();
			runner.trigger();

			// withExclusive should reject pending triggers and invalidate them
			const cancelEx = runner.withExclusive(async () => {
				order.push('cancel-exclusive');
				await Promise.resolve();
			});

			barrier.resolve();
			await holdDone.catch(() => {
				// expected: may be cancelled
			});
			await cancelEx;
			await tick();

			// The pending normal triggers should have been cancelled.
			// Only holding and cancel-exclusive should have run.
			expect(order).to.deep.equal(['holding', 'cancel-exclusive']);
		});
	});

	describe('recursive calls', () => {
		it('does not deadlock when fn triggers a retry via trigger()', async () => {
			let callCount = 0;
			const runner = new ExclusiveRunner(async () => {
				callCount++;
				if (callCount === 1) {
					// Simulate error handling scheduling a retry
					runner.trigger();
				}
				// Second call just returns
				await Promise.resolve();
			});

			runner.trigger();

			// Wait enough time for both the first call and the retry to complete
			await tick(100);

			expect(callCount).to.equal(2);
		});

		it('handles recursive self-calls within fn', async () => {
			let depth = 0;
			let maxDepth = 0;
			const runner = new ExclusiveRunner(async ({ abortSignal }) => {
				depth++;
				maxDepth = Math.max(maxDepth, depth);
				if (depth < 3) {
					// Recursive call simulates applyTarget calling itself
					// In the real code, applyTarget calls itself directly, not via trigger,
					// which is fine because it's already inside the semaphore-held callback.
					await (runner as any).fn({
						force: false,
						initial: false,
						abortSignal,
					});
				}
				depth--;
			});

			runner.trigger();
			await tick();

			expect(maxDepth).to.equal(3);
		});
	});
});
