import { SinonStub, stub, spy, SinonSpy } from 'sinon';
import { Promise } from 'bluebird';
import * as _ from 'lodash';
import rewire = require('rewire');
import { expect } from 'chai';

import { sleep } from '~/test-lib/helpers';
import * as TargetState from '~/src/device-state/target-state';
import Log from '~/lib/supervisor-console';
import * as request from '~/lib/request';
import * as deviceConfig from '~/src/device-config';
import { UpdatesLockedError } from '~/lib/errors';

const deviceState = rewire('~/src/device-state');

const stateEndpointBody = {
	local: {
		name: 'solitary-bush',
		config: {},
		apps: {
			'123': {
				name: 'my-app',
				services: {},
				volumes: {},
				networks: {},
			},
		},
	},
	dependent: {
		apps: {},
		devices: {},
	},
};

const req = {
	getAsync: () =>
		Promise.resolve([
			{
				statusCode: 200,
				headers: { etag: 'abc' },
			} as any,
			JSON.stringify(stateEndpointBody),
		]),
};

describe('Target state', () => {
	before(async () => {
		// maxPollTime starts as undefined
		deviceState.__set__('maxPollTime', 60000);

		stub(deviceState, 'applyStep').resolves();
	});

	beforeEach(() => {
		spy(req, 'getAsync');
		stub(request, 'getRequestInstance').resolves(req as any);
	});

	afterEach(() => {
		(req.getAsync as SinonSpy).restore();
		(request.getRequestInstance as SinonStub).restore();
	});

	after(async () => {
		(deviceState.applyStep as SinonStub).restore();
	});

	describe('update', () => {
		it('should throw if a 304 is received but no local cache exists', async () => {
			// new request returns 304
			const newReq = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 304,
							headers: {},
						} as any,
					]),
			};

			(request.getRequestInstance as SinonStub).resolves(newReq as any);

			// Perform target state request
			await expect(TargetState.update()).to.be.rejected;
			expect(request.getRequestInstance).to.be.calledOnce;
		});

		it('should emit target state when a new one is available', async () => {
			// Setup target state listener
			const listener = stub();
			TargetState.emitter.on('target-state-update', listener);

			// Perform target state request
			await TargetState.update();

			expect(request.getRequestInstance).to.be.calledOnce;

			// The getAsync method gets called once and includes authorization headers
			expect(req.getAsync).to.be.calledOnce;
			expect(
				_.has((req.getAsync as SinonSpy).args[0], ['headers', 'Authorization']),
			);

			// The listener should receive the endpoint
			expect(listener).to.be.calledOnceWith(JSON.stringify(stateEndpointBody));

			// Remove getRequestInstance stub
			(request.getRequestInstance as SinonStub).restore();

			// new request returns 304
			const newReq = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 304,
							headers: {},
						} as any,
					]),
			};

			spy(newReq, 'getAsync');
			stub(request, 'getRequestInstance').resolves(newReq as any);

			// Perform new target state request
			await TargetState.update();

			// The new req should have been called
			expect(newReq.getAsync).to.be.calledOnce;

			// No new calls to the listener
			expect(listener).to.be.calledOnce;

			// Cleanup
			TargetState.emitter.off('target-state-update', listener);
		});

		it('should emit cached target state if there was no listener for the cached state', async () => {
			// Perform target state request
			await TargetState.update();

			expect(request.getRequestInstance).to.be.calledOnce;

			// The getAsync method gets called once and includes authorization headers
			expect(req.getAsync).to.be.calledOnce;
			expect(
				_.has((req.getAsync as SinonSpy).args[0], ['headers', 'Authorization']),
			);

			// Remove getRequestInstance stub
			(request.getRequestInstance as SinonStub).restore();

			// new request returns 304
			const newReq = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 304,
							headers: {},
						} as any,
					]),
			};

			spy(newReq, 'getAsync');
			stub(request, 'getRequestInstance').resolves(newReq as any);

			// Setup target state listener after the first request
			const listener = stub();
			TargetState.emitter.on('target-state-update', listener);

			// Perform new target state request
			await TargetState.update();

			// The new req should have been called
			expect(newReq.getAsync).to.be.calledOnce;

			// The listener should receive the endpoint
			expect(listener).to.be.calledOnceWith(JSON.stringify(stateEndpointBody));

			// Cleanup
			TargetState.emitter.off('target-state-update', listener);
		});

		it('should cancel any target state applying if request is from API', async () => {
			const logInfoSpy = spy(Log, 'info');

			// This just makes the first step of the applyTarget function throw an error
			// We could have stubbed any function to throw this error as long as it is inside the try block
			stub(deviceConfig, 'getRequiredSteps').throws(
				new UpdatesLockedError('Updates locked'),
			);

			// Rather then stubbing more values to make the following code execute
			// I am just going to make the function I want run
			const updateListener = async (
				_targetState: any,
				force: boolean,
				isFromApi: boolean,
			) => {
				deviceState.triggerApplyTarget({ force, isFromApi });
			};
			const applyListener = async (force: boolean, isFromApi: boolean) => {
				deviceState.triggerApplyTarget({ force, isFromApi });
			};

			// Add the function we want to run to this listener which calls it normally
			TargetState.emitter.on('target-state-update', updateListener);
			TargetState.emitter.on('target-state-apply', applyListener);

			// Trigger an update which will start delay due to lock exception
			await TargetState.update(false, false);

			// Wait for interval to tick a few times
			await sleep(2000); // 2 seconds

			// Trigger another update but say it's from the API
			await TargetState.update(false, true);

			// Check for log message stating cancellation
			expect(logInfoSpy.lastCall?.lastArg).to.equal(
				'Skipping applyTarget because of a cancellation',
			);

			// Restore stubs
			logInfoSpy.restore();
			(deviceConfig.getRequiredSteps as SinonStub).restore();
			TargetState.emitter.off('target-state-update', updateListener);
			TargetState.emitter.off('target-state-apply', applyListener);
		});
	});

	describe('get', () => {
		it('returns the latest target state endpoint response', async () => {
			// Perform target state request
			const response = await TargetState.get();

			// The stubbed methods should only be called once
			expect(request.getRequestInstance).to.be.calledOnce;
			expect(req.getAsync).to.be.calledOnce;

			// Cached value should reflect latest response
			expect(response).to.be.equal(JSON.stringify(stateEndpointBody));
		});

		it('returns the last cached target state', async () => {
			// Perform target state request, this should
			// put the query result in the cache
			await TargetState.update();

			// Reset the stub
			(request.getRequestInstance as SinonStub).restore();
			const newReq = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 304,
							headers: {},
						} as any,
					]),
			};
			spy(newReq, 'getAsync');
			stub(request, 'getRequestInstance').resolves(newReq as any);

			// Perform target state request
			const response = await TargetState.get();

			// The stubbed methods should only be called once
			expect(request.getRequestInstance).to.be.calledOnce;
			expect(newReq.getAsync).to.be.calledOnce;

			// Cached value should reflect latest response
			expect(response).to.be.equal(JSON.stringify(stateEndpointBody));
		});
	});
});
