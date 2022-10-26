import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';

import * as deviceState from '~/src/device-state';
import { getGlobalApiKey, generateScopedKey } from '~/src/device-api';
import * as actions from '~/src/device-api/actions';

describe('regenerates API keys', () => {
	// Stub external dependency - current state report should be tested separately.
	// api-key.ts methods are also tested separately.
	beforeEach(() => stub(deviceState, 'reportCurrentState'));
	afterEach(() => (deviceState.reportCurrentState as SinonStub).restore());

	it("communicates new key to cloud if it's a global key", async () => {
		const originalGlobalKey = await getGlobalApiKey();
		const newKey = await actions.regenerateKey(originalGlobalKey);
		expect(originalGlobalKey).to.not.equal(newKey);
		expect(newKey).to.equal(await getGlobalApiKey());
		expect(deviceState.reportCurrentState as SinonStub).to.have.been.calledOnce;
		expect(
			(deviceState.reportCurrentState as SinonStub).firstCall.args[0],
		).to.deep.equal({
			api_secret: newKey,
		});
	});

	it("doesn't communicate new key if it's a service key", async () => {
		const originalScopedKey = await generateScopedKey(111, 'main');
		const newKey = await actions.regenerateKey(originalScopedKey);
		expect(originalScopedKey).to.not.equal(newKey);
		expect(newKey).to.not.equal(await getGlobalApiKey());
		expect(deviceState.reportCurrentState as SinonStub).to.not.have.been.called;
	});
});
