import { SinonStub, stub, spy, SinonSpy } from 'sinon';
import { Promise } from 'bluebird';

import * as _ from 'lodash';

import { expect } from './lib/chai-config';
import * as TargetState from '../src/device-state/target-state';
import * as request from '../src/lib/request';

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

describe('Target state', () => {
	describe('update', () => {
		it('should emit target state when a new one is available', async () => {
			const req = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 200,
							headers: {},
						} as any,
						JSON.stringify(stateEndpointBody),
					]),
			};

			spy(req, 'getAsync');
			stub(request, 'getRequestInstance').resolves(req as any);

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
			(request.getRequestInstance as SinonStub).restore();
		});

		it('should emit cached target state if there was no listener for the cached state', async () => {
			const req = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 200,
							headers: {},
						} as any,
						JSON.stringify(stateEndpointBody),
					]),
			};

			spy(req, 'getAsync');
			stub(request, 'getRequestInstance').resolves(req as any);

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
			(request.getRequestInstance as SinonStub).restore();
		});
	});

	describe('get', () => {
		it('returns the latest target state endpoint response', async () => {
			const req = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 200,
							headers: {},
						} as any,
						JSON.stringify(stateEndpointBody),
					]),
			};

			// Setup spies and stubs
			spy(req, 'getAsync');
			stub(request, 'getRequestInstance').resolves(req as any);

			// Perform target state request
			const response = await TargetState.get();

			// The stubbed methods should only be called once
			expect(request.getRequestInstance).to.be.calledOnce;
			expect(req.getAsync).to.be.calledOnce;

			// Cached value should reflect latest response
			expect(response).to.be.equal(JSON.stringify(stateEndpointBody));

			// Cleanup
			(request.getRequestInstance as SinonStub).restore();
		});

		it('returns the last cached target state', async () => {
			const req = {
				getAsync: () =>
					Promise.resolve([
						{
							statusCode: 200,
							headers: {},
						} as any,
						JSON.stringify(stateEndpointBody),
					]),
			};

			// Setup spies and stubs
			stub(request, 'getRequestInstance').resolves(req as any);

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

			// Cleanup
			(request.getRequestInstance as SinonStub).restore();
		});
	});
});
