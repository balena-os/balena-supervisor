import { expect } from 'chai';
import * as sinon from 'sinon';
import { setTimeout } from 'timers/promises';
import * as deviceState from '~/src/device-state';
import { createCancellableTrigger } from '~/src/device-state';

describe('usingInferStepsLock', () => {
	it('should not allow to start a function call without finishing the previous sequential call of the function', async () => {
		const result: string[] = [];
		const fn = async (id: number, str: string) => {
			return deviceState.usingInferStepsLock(async () => {
				if (id < 3 || id === 20) {
					result.push(`Started ${id}, ${str} call`);
					await fn(id + 1, 'first');
					await fn(id + 1, 'second');
					result.push(`Finished ${id}, ${str} call`);
				}
			});
		};
		await fn(1, 'master');
		await fn(20, 'master');
		expect(result).to.deep.equal([
			'Started 1, master call',
			'Started 2, first call',
			'Finished 2, first call',
			'Started 2, second call',
			'Finished 2, second call',
			'Finished 1, master call',
			'Started 20, master call',
			'Finished 20, master call',
		]);
	});
});

describe('createCancellableTrigger', () => {
	// Wait for microtasks / async promise chains to settle
	const settle = () => setTimeout(50);

	// Create a deferred promise
	function deferred() {
		let resolve!: () => void;
		let reject!: (err: Error) => void;
		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	it('calls promise with correct arguments', async () => {
		const stub = sinon.stub().resolves();
		const { trigger } = createCancellableTrigger(stub);

		trigger({ force: true });
		await settle();

		expect(stub).to.have.been.calledOnce;
		expect(stub).to.have.been.calledWith(
			sinon.match({
				force: true,
				initial: false,
				abortSignal: sinon.match.instanceOf(AbortSignal),
			}),
		);
	});

	it('passes initial flag to promise', async () => {
		const stub = sinon.stub().resolves();
		const { trigger } = createCancellableTrigger(stub);

		trigger({ initial: true });
		await settle();

		expect(stub).to.have.been.calledWith(sinon.match({ initial: true }));
	});

	it('sets isInProgress while promise is running', async () => {
		const d = deferred();
		const stub = sinon.stub().returns(d.promise);
		const { trigger, isInProgress } = createCancellableTrigger(stub);

		trigger();
		await settle();

		expect(isInProgress()).to.be.true;

		d.resolve();
		await settle();

		expect(isInProgress()).to.be.false;
	});

	it('queues rather than triggers a second promise while one is in progress', async () => {
		const d = deferred();
		const stub = sinon.stub().returns(d.promise);
		const { trigger, hasScheduled } = createCancellableTrigger(stub);

		trigger({ force: true });
		await settle();
		expect(stub).to.have.been.calledOnce;

		// Second trigger while in progress should queue, not call again
		trigger({ force: true });
		await settle();
		expect(stub).to.have.been.calledOnce;
		expect(hasScheduled()).to.be.true;

		d.resolve();
		await settle();
	});

	it('dispatches scheduled promise after current promise completes', async () => {
		const d = deferred();
		const stub = sinon
			.stub()
			.onFirstCall()
			.returns(d.promise)
			.onSecondCall()
			.resolves();
		const { trigger, hasScheduled } = createCancellableTrigger(stub);

		trigger({ force: true });
		await settle();

		trigger({ force: false });
		expect(stub).to.have.been.calledOnce;

		// Complete first promise call — should dispatch scheduled promise
		d.resolve();
		await settle();

		expect(stub).to.have.been.calledTwice;
		expect(hasScheduled()).to.be.false;
	});

	it('merges force flag into existing scheduled promise', async () => {
		const d = deferred();
		const stub = sinon
			.stub()
			.onFirstCall()
			.returns(d.promise)
			.onSecondCall()
			.resolves();
		const { trigger } = createCancellableTrigger(stub);

		trigger();
		await settle();

		// Queue two promise calls — force should be OR'd
		trigger({ force: false });
		trigger({ force: true });

		d.resolve();
		await settle();

		// The second call to promise (from drain) should have force: true
		expect(stub.secondCall).to.have.been.calledWith(
			sinon.match({ force: true }),
		);
	});

	it('waits for delay before starting promise', async () => {
		const stub = sinon.stub().resolves();
		const { trigger } = createCancellableTrigger(stub);

		trigger({ delay: 200 });

		// Should not have been called yet
		await setTimeout(50);
		expect(stub).to.not.have.been.called;

		// Should be called after the delay
		await setTimeout(200);
		expect(stub).to.have.been.calledOnce;
	});

	it('skips delay when isFromApi cancels it', async () => {
		const d = deferred();
		const stub = sinon
			.stub()
			.onFirstCall()
			.returns(d.promise)
			.onSecondCall()
			.resolves();
		const { trigger, isInProgress, hasScheduled } =
			createCancellableTrigger(stub);

		// Trigger a promise after a long delay
		trigger({ delay: 5000 });
		await settle();

		// The promise should be in progress (in the delay phase)
		expect(isInProgress()).to.be.true;
		expect(stub).to.not.have.been.called;

		// API call should cancel the delay and queue a new promise
		trigger({ isFromApi: true });
		await settle();

		// The delay was cancelled, so the old promise was skipped.
		// The scheduled promise should have been dispatched.
		expect(stub).to.have.been.calledOnce;
		expect(hasScheduled()).to.be.false;
	});

	it('provides an abort signal to promise to allow cancellation of in-progress promise', async () => {
		let receivedSignal: AbortSignal | undefined;
		const d = deferred();
		const stub = sinon.stub().callsFake((opts: any) => {
			receivedSignal = opts.abortSignal;
			return d.promise;
		});
		const { trigger } = createCancellableTrigger(stub);

		trigger();
		await settle();

		expect(receivedSignal).to.be.instanceOf(AbortSignal);
		expect(receivedSignal!.aborted).to.be.false;

		d.resolve();
		await settle();
	});

	it('aborts the signal when cancel is true', async () => {
		let receivedSignal: AbortSignal | undefined;
		const d = deferred();
		const stub = sinon.stub().callsFake((opts: any) => {
			receivedSignal = opts.abortSignal;
			return d.promise;
		});
		const { trigger } = createCancellableTrigger(stub);

		trigger();
		await settle();

		expect(receivedSignal).to.not.be.undefined;
		expect(receivedSignal!.aborted).to.be.false;

		// Cancel the in-progress promise
		trigger({ cancel: true });

		expect(receivedSignal!.aborted).to.be.true;

		d.resolve();
		await settle();
	});
});
