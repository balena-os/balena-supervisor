import { expect } from 'chai';
import nock from 'nock';
import * as sinon from 'sinon';

import * as config from '~/src/config';
import * as TargetState from '~/src/api-binder/poll';

describe('api-binder/poll', () => {
	let apiEndpoint: string;
	let uuid: string;
	const onUpdate = sinon.spy();
	const onApply = sinon.spy();

	before(async () => {
		await config.initialized();
		apiEndpoint = await config.get('apiEndpoint');
		const $uuid = await config.get('uuid');
		if ($uuid == null) {
			throw new Error('Device uuid is required for poll tests');
		}
		uuid = $uuid;

		TargetState.emitter.on('target-state-update', onUpdate);
		TargetState.emitter.on('target-state-apply', onApply);
	});

	after(() => {
		TargetState.emitter.off('target-state-update', onUpdate);
		TargetState.emitter.off('target-state-apply', onApply);
	});

	beforeEach(() => {
		onUpdate.resetHistory();
		onApply.resetHistory();
	});

	afterEach(() => {
		nock.cleanAll();
	});

	// The target state cache is module state that is only empty until the
	// first successful response, so these tests must run before any 200 reply
	describe('with no cached target state', () => {
		it('does not throw or emit when the API replies with 304', async () => {
			const scope = nock(apiEndpoint)
				.get(`/device/v3/${uuid}/state`)
				.reply(304);

			await expect(TargetState.update()).to.not.be.rejected;
			expect(scope.isDone()).to.be.true;
			expect(onUpdate).to.not.have.been.called;
			expect(onApply).to.not.have.been.called;
		});

		it('rejects get() when the API replies with 304', async () => {
			const scope = nock(apiEndpoint)
				.get(`/device/v3/${uuid}/state`)
				.reply(304);

			await expect(TargetState.get()).to.be.rejectedWith(
				TargetState.ApiResponseError,
				'No target state available from the API',
			);
			expect(scope.isDone()).to.be.true;
			expect(onUpdate).to.not.have.been.called;
		});
	});

	describe('with a cached target state', () => {
		const target = { local: { name: 'test-device' } };
		const etag = '"target-etag"';

		before(async () => {
			nock(apiEndpoint)
				.get(`/device/v3/${uuid}/state`)
				.reply(200, { [uuid]: target }, { ETag: etag });
			await TargetState.update();
		});

		it('sends the cached etag and does not re-emit on 304', async () => {
			const scope = nock(apiEndpoint, {
				reqheaders: { 'if-none-match': etag },
			})
				.get(`/device/v3/${uuid}/state`)
				.reply(304);

			await TargetState.update();
			expect(scope.isDone()).to.be.true;
			expect(onUpdate).to.not.have.been.called;
			expect(onApply).to.not.have.been.called;
		});

		it('emits an apply on 304 when the update comes from the API', async () => {
			nock(apiEndpoint).get(`/device/v3/${uuid}/state`).reply(304);

			await TargetState.update(false, true);
			expect(onUpdate).to.not.have.been.called;
			expect(onApply).to.have.been.calledOnceWith(false, true, false);
		});

		it('returns the cached target from get() on 304', async () => {
			nock(apiEndpoint).get(`/device/v3/${uuid}/state`).reply(304);

			expect(await TargetState.get()).to.deep.equal({ [uuid]: target });
		});

		it('emits the new target and cancels on 200', async () => {
			const newTarget = { local: { name: 'new-name' } };
			nock(apiEndpoint)
				.get(`/device/v3/${uuid}/state`)
				.reply(200, { [uuid]: newTarget }, { ETag: '"new-etag"' });

			await TargetState.update();
			expect(onUpdate).to.have.been.calledOnceWith(
				{ [uuid]: newTarget },
				false,
				false,
				true,
			);
		});
	});
});
