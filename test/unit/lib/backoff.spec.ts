import { assert, expect } from 'chai';
import * as sinon from 'sinon';

import { StatusError } from '~/lib/errors';
import type { OnFailureInfo } from '~/lib/backoff';
import { withBackoff } from '~/lib/backoff';

const DEFAULT_OPTIONS = {
	maxRetries: 5,
	maxDelay: 900000, // 15 minutes
	minDelay: 10000, // 10 seconds
};

describe('lib/backoff', async () => {
	let clock: sinon.SinonFakeTimers;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it('resolves after 3 retries', async () => {
		// Create a function that will fail 3 times so it succeeds on the 4th
		const failer = new Failer(3);
		// Wrap function withBackoff
		const fnWithBackoff = withBackoff(async () => {
			return failer.willResolve('fails 3 times then resolves on 4th');
		}, DEFAULT_OPTIONS);
		// Call function and allow clock to trigger all events
		void clock.runAllAsync();
		await expect(fnWithBackoff()).to.eventually.equal(
			'fails 3 times then resolves on 4th',
		);
		// Check that function was called 4 times (failed 3 times, succeeds on 4th)
		expect(failer.callCount).to.equal(4);
	});

	it('should not call the function before minDelay', async () => {
		const failer = new Failer(3);
		const minDelay = Math.floor(Math.random() * 1000);
		const myBackoffFunc = withBackoff(
			async () => {
				return failer.willResolve('ok');
			},
			{
				minDelay,
			},
		);
		// Function should have been called 0 times to start
		expect(failer.callCount).to.equal(0);
		// Call function
		void myBackoffFunc();
		// Check that function was run at least once
		expect(failer.callCount).to.equal(1);
		// Elapse some time but not enough to be minDelay
		await clock.tickAsync(minDelay - 1);
		// Check that the function still has only been called 1 time
		expect(failer.callCount).to.equal(1);
		// Elapse exactly minDelay so function is called once more
		await clock.tickAsync(minDelay + 1);
		// Check that function was called twice
		expect(failer.callCount).to.equal(2);
	});

	it('backs off with exponential delay', async () => {
		const failer = new Failer(3);
		const minDelay = Math.floor(Math.random() * 1000);
		const myBackoffFunc = withBackoff(
			async () => {
				return failer.willResolve('ok');
			},
			{
				minDelay,
				maxDelay: 5000000,
			},
		);
		expect(failer.callCount).to.equal(0);
		// Call function
		const p = myBackoffFunc();
		// Function is called immediately
		expect(failer.callCount).to.equal(1);
		// First delay is equal to minDelay
		await clock.tickAsync(minDelay);
		// Should have been called again
		expect(failer.callCount).to.equal(2);
		// Tick exponential time
		await clock.tickAsync(minDelay * 2);
		// Should have been called again
		expect(failer.callCount).to.equal(3);
		// Tick exponential time
		await clock.tickAsync(minDelay * 2 * 2);
		// Function should be fulfilled by now
		await expect(p).to.be.fulfilled;
		expect(failer.callCount).to.equal(4);
	});

	it('never exceeds maxRetries', async () => {
		// Make the failer fail 100 times (more then maxRetries)
		const failer = new Failer(100);
		const fnWithBackoff = withBackoff(async () => {
			return failer.willResolve('ok');
		}, DEFAULT_OPTIONS);
		void clock.runAllAsync();
		// Call the function
		await expect(fnWithBackoff()).to.eventually.be.rejectedWith(
			`Reached max number of retries: ${DEFAULT_OPTIONS.maxRetries}`,
		);
	});

	it('provides correct info within onFailure callback', async () => {
		// Create a function that will fail 3 times so it succeeds on the 4th
		const failer = new Failer(3);
		const minDelay = Math.floor(Math.random() * 1000);
		let counter = 0;
		// Wrap function withBackoff
		const fnWithBackoff = withBackoff(
			async () => {
				return failer.willResolve('ok');
			},
			{
				minDelay,
				onFailure: (data: OnFailureInfo) => {
					counter++;
					expect(data).to.deep.equal({
						failures: counter,
						delay:
							counter === 1 ? minDelay : exponentialize(minDelay, counter - 1),
						error: 'Not ready!',
					});
				},
			},
		);
		// Call function and allow clock to trigger all events
		void clock.runAllAsync();
		await fnWithBackoff();
	});

	it('uses RetryAfter from exception thrown', async () => {
		const retryAfter = 50000;
		const minDelay = 1000;
		const failer = new Failer(
			1,
			new StatusError(503, 'Service Unavailable', retryAfter),
		);
		const fnWithBackoff = withBackoff(
			async () => {
				return failer.willResolve('ok');
			},
			{
				minDelay,
			},
		);
		assert(retryAfter > minDelay, 'retryAfter must be greater than minDelay');
		expect(failer.callCount).to.equal(0);
		// Start calling function that fails with retryAfter
		const p = fnWithBackoff();
		// Check that function was only called once (it runs right away)
		expect(failer.callCount).to.equal(1);
		// Tick clock by minDelay
		// This will not be enough to call the function because retryAfter was in the
		// exception thrown and it is greater then minDelay
		await clock.tickAsync(minDelay);
		// Check that function wasn't called yet
		expect(failer.callCount).to.equal(1);
		// Tick clock again just before retryAfter
		await clock.tickAsync(retryAfter - minDelay - 1);
		// Check that call count is still only 1 since retryAfter time has not elapsed
		expect(failer.callCount).to.equal(1);
		// Elapse enough time to trigger function call
		await clock.tickAsync(1);
		// Check that function has now been called once more
		expect(failer.callCount).to.equal(2);
		// Failure was set to only fail once so function should be fulfilled after 2 executions
		await expect(p).to.be.fulfilled;
	});
});

function exponentialize(n: number, timesToExpo: number): number {
	let product = 0;
	let exponentialized = 0;
	function expo(): number {
		if (exponentialized >= timesToExpo) {
			return product;
		}
		exponentialized++;
		product = product + n * 2;
		return expo();
	}
	return expo();
}

class Failer {
	public maxFails: number;
	public callCount: number;
	public customError?: Error;

	public constructor(maxFails: number, error?: Error) {
		this.maxFails = maxFails;
		this.callCount = 0;
		this.customError = error;
	}

	public async willResolve(resolvesWith: string): Promise<string> {
		return new Promise((resolve, reject) => {
			if (++this.callCount <= this.maxFails) {
				if (this.customError) {
					return reject(this.customError);
				}
				return reject('Not ready!');
			}
			return resolve(resolvesWith);
		});
	}
}
