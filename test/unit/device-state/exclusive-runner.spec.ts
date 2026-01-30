import { expect } from 'chai';
import { setTimeout } from 'timers/promises';
import type { SinonStub } from 'sinon';

import { ExclusiveRunner } from '~/src/device-state/exclusive-runner';
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
		});

		it('passes an empty object to fn when called with no args', async () => {
			let receivedOpts: any = null;
			const runner = new ExclusiveRunner(async (opts) => {
				receivedOpts = opts;
				await Promise.resolve();
			});

			runner.trigger();
			await tick();

			expect(receivedOpts).to.deep.equal({});
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
		it('withExclusive runs before queued normal triggers', async () => {
			const order: string[] = [];
			const initialBarrier = deferred();

			const runner = new ExclusiveRunner(async () => {
				order.push('normal');
				await Promise.resolve();
			});

			// Start an initial normal apply that holds the semaphore
			const holdingSemaphore = runner.withExclusive(async () => {
				order.push('holding');
				await initialBarrier.promise;
			});
			await tick();

			// Queue normal triggers first
			runner.trigger();
			runner.trigger();

			// Queue exclusive calls after
			const ex1 = runner.withExclusive(async () => {
				order.push('exclusive-1');
				await Promise.resolve();
			});
			const ex2 = runner.withExclusive(async () => {
				order.push('exclusive-2');
				await Promise.resolve();
			});

			// Release the initial holder
			initialBarrier.resolve();
			await holdingSemaphore;
			await ex1;
			await ex2;
			await tick();

			// Both exclusive calls should have run before any normal triggers
			expect(order).to.deep.equal([
				'holding',
				'exclusive-1',
				'exclusive-2',
				'normal',
				'normal',
			]);
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
			const runner = new ExclusiveRunner(async () => {
				depth++;
				maxDepth = Math.max(maxDepth, depth);
				if (depth < 3) {
					// Recursive call simulates applyTarget calling itself
					// In the real code, applyTarget calls itself directly, not via trigger,
					// which is fine because it's already inside the semaphore-held callback.
					await (runner as any).fn({
						force: false,
						initial: false,
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
