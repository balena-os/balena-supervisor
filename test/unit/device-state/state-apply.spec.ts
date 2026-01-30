import { expect } from 'chai';
import { setTimeout } from 'timers/promises';
import type { SinonStub } from 'sinon';

import { StateApplicator } from '~/src/device-state/state-apply';
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

describe('StateApplicator', () => {
	describe('trigger', () => {
		it('calls the applyFn with the provided options', async () => {
			let receivedOpts: any = null;
			const applicator = new StateApplicator(async (opts) => {
				receivedOpts = opts;
				await Promise.resolve();
			});

			applicator.trigger({ force: true, initial: true });
			await tick();

			expect(receivedOpts).to.have.property('force', true);
			expect(receivedOpts).to.have.property('initial', true);
			expect(receivedOpts)
				.to.have.property('abortSignal')
				.that.is.instanceof(AbortSignal);
		});

		it('defaults `force` and `initial` to false', async () => {
			let receivedOpts: any = null;
			const applicator = new StateApplicator(async (opts) => {
				receivedOpts = opts;
				await Promise.resolve();
			});

			applicator.trigger();
			await tick();

			expect(receivedOpts).to.have.property('force', false);
			expect(receivedOpts).to.have.property('initial', false);
		});

		it('logs an unhandled error when applyFn throws, because applyFn should handle its own errors', async () => {
			const applicator = new StateApplicator(async function myFn() {
				await Promise.resolve();
				throw new Error('unhandled error');
			});

			applicator.trigger();
			await tick();
			expect(log.error as SinonStub).to.have.been.calledWith(
				'Unhandled error thrown from myFn: unhandled error',
			);
		});

		it('releases the semaphore after applyFn throws so subsequent applies can run', async () => {
			let callCount = 0;
			const applicator = new StateApplicator(async () => {
				if (++callCount === 1) {
					throw new Error('first apply fails');
				}
				await Promise.resolve();
			});

			applicator.trigger();
			await tick();
			expect(callCount).to.equal(1);

			// Second trigger should still run
			applicator.trigger();
			await tick();
			expect(callCount).to.equal(2);
		});
	});

	describe('withExclusive', () => {
		it('is not affected by a normal trigger with cancel=true', async () => {
			let exclusiveRan = false;
			const barrier = deferred();

			const applicator = new StateApplicator(async () => {
				await Promise.resolve();
			});

			const exclusiveDone = applicator.withExclusive(async () => {
				await barrier.promise;
				exclusiveRan = true;
			});
			await tick();

			// A normal trigger with cancel should not affect the exclusive apply
			applicator.trigger({ cancel: true });
			await tick();

			barrier.resolve();
			await exclusiveDone;

			expect(exclusiveRan).to.be.true;
		});

		it('holds the lock for the entire callback', async () => {
			const order: string[] = [];
			const applicator = new StateApplicator(async () => {
				order.push('normal');
				await Promise.resolve();
			});

			// Start an exclusive sequence
			const exclusiveDone = applicator.withExclusive(async () => {
				order.push('exclusive-step-1');
				await tick(20);
				order.push('exclusive-step-2');
				await tick(20);
				order.push('exclusive-step-3');
			});

			// Queue a normal trigger during the exclusive hold
			applicator.trigger();

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
			const applicator = new StateApplicator(async () => {
				await Promise.resolve();
			});

			await applicator.withExclusive(async () => {
				await tick(20);
				completed = true;
			});

			expect(completed).to.be.true;
		});

		it('releases the semaphore after error so subsequent applies can run', async () => {
			let normalRan = false;
			const applicator = new StateApplicator(async () => {
				normalRan = true;
				await Promise.resolve();
			});

			try {
				await applicator.withExclusive(async () => {
					await Promise.resolve();
					throw new Error('fail');
				});
			} catch {
				// expected
			}

			applicator.trigger();
			await tick();

			expect(normalRan).to.be.true;
		});
	});

	describe('mutual exclusion', () => {
		it('runs only one apply at a time', async () => {
			let running = 0;
			let maxRunning = 0;
			let callIndex = 0;
			const barriers = [deferred(), deferred(), deferred()];

			const applicator = new StateApplicator(async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await barriers[callIndex++].promise;
				running--;
			});

			applicator.trigger();
			applicator.trigger();
			applicator.trigger();

			await tick();
			expect([running, maxRunning]).to.deep.equal([1, 1]);

			// Release first apply
			barriers[0].resolve();
			await tick();
			expect([running, maxRunning]).to.deep.equal([1, 1]);

			// Release second apply
			barriers[1].resolve();
			await tick();
			expect([running, maxRunning]).to.deep.equal([1, 1]);

			// Release third apply
			barriers[2].resolve();
			await tick();
			expect([running, maxRunning]).to.deep.equal([0, 1]);
		});

		it('isInProgress returns true while apply is running', async () => {
			const barrier = deferred();
			const applicator = new StateApplicator(async () => {
				await barrier.promise;
			});

			expect(applicator.isInProgress()).to.be.false;

			applicator.trigger();
			await tick();
			expect(applicator.isInProgress()).to.be.true;

			barrier.resolve();
			await tick();
			expect(applicator.isInProgress()).to.be.false;
		});

		it('isInProgress returns true while withExclusive is running', async () => {
			const barrier = deferred();
			const applicator = new StateApplicator(async () => {
				await Promise.resolve();
			});

			expect(applicator.isInProgress()).to.be.false;

			const exclusiveDone = applicator.withExclusive(async () => {
				await barrier.promise;
			});
			await tick();
			expect(applicator.isInProgress()).to.be.true;

			barrier.resolve();
			await exclusiveDone;
			expect(applicator.isInProgress()).to.be.false;
		});
	});

	describe('priority', () => {
		it('withExclusive runs before queued normal triggers', async () => {
			const order: string[] = [];
			const initialBarrier = deferred();

			const applicator = new StateApplicator(async () => {
				order.push('normal');
				await Promise.resolve();
			});

			// Start an initial normal apply that holds the semaphore
			const holdingSemaphore = applicator.withExclusive(async () => {
				order.push('holding');
				await initialBarrier.promise;
			});
			await tick();

			// Queue normal applies first
			applicator.trigger();
			applicator.trigger();

			// Queue exclusive applies after
			const ex1 = applicator.withExclusive(async () => {
				order.push('exclusive-1');
				await Promise.resolve();
			});
			const ex2 = applicator.withExclusive(async () => {
				order.push('exclusive-2');
				await Promise.resolve();
			});

			// Release the initial holder
			initialBarrier.resolve();
			await holdingSemaphore;
			await ex1;
			await ex2;
			await tick();

			// Both exclusive applies should have run before any normal applies
			expect(order).to.deep.equal([
				'holding',
				'exclusive-1',
				'exclusive-2',
				'normal',
				'normal',
			]);
		});
	});

	describe('cancellation', () => {
		it('cancel with nothing running still queues an apply', async () => {
			let called = false;
			const applicator = new StateApplicator(async () => {
				called = true;
				await Promise.resolve();
			});

			applicator.trigger({ cancel: true });
			await tick();

			expect(called).to.be.true;
		});

		it('aborts the running apply when cancel=true', async () => {
			let aborted = false;
			const barrier = deferred();
			const applicator = new StateApplicator(async ({ abortSignal }) => {
				abortSignal.addEventListener('abort', () => {
					aborted = true;
				});
				await barrier.promise;
			});

			applicator.trigger();
			await tick();
			expect(aborted).to.be.false;

			applicator.trigger({ cancel: true });
			await tick();
			expect(aborted).to.be.true;

			barrier.resolve();
			await tick();
		});

		it('runs the new apply after the cancelled one finishes', async () => {
			const calls: number[] = [];
			let callCount = 0;
			const barriers = [deferred(), deferred()];

			const applicator = new StateApplicator(async ({ abortSignal }) => {
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

			applicator.trigger();
			await tick();
			expect(calls).to.deep.equal([0]);

			// Cancel and dispatch new apply
			applicator.trigger({ cancel: true });
			await tick(50);
			expect(calls).to.deep.equal([0, 1]);

			barriers[1].resolve();
			await tick();
		});
	});

	describe('recursive calls', () => {
		it('does not deadlock when applyFn triggers a retry via trigger()', async () => {
			let callCount = 0;
			const applicator = new StateApplicator(async () => {
				callCount++;
				if (callCount === 1) {
					// Simulate applyError scheduling a retry
					applicator.trigger();
				}
				// Second call just returns
				await Promise.resolve();
			});

			applicator.trigger();

			// Wait enough time for both the first apply and the retry to complete
			await tick(100);

			expect(callCount).to.equal(2);
		});

		it('handles recursive self-calls within applyFn', async () => {
			let depth = 0;
			let maxDepth = 0;
			const applicator = new StateApplicator(async ({ abortSignal }) => {
				depth++;
				maxDepth = Math.max(maxDepth, depth);
				if (depth < 3) {
					// Recursive call simulates applyTarget calling itself
					// In the real code, applyTarget calls itself directly, not via trigger,
					// which is fine because it's already inside the semaphore-held callback.
					await applicator['applyFn']({
						force: false,
						initial: false,
						abortSignal,
					});
				}
				depth--;
			});

			applicator.trigger();
			await tick();

			expect(maxDepth).to.equal(3);
		});
	});
});
