import { expect } from 'chai';
import type { SinonSpy } from 'sinon';
import { spy } from 'sinon';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';

import * as config from '~/src/config';
import * as logger from '~/src/logging';
import { BalenaLogBackend } from '~/src/logging/balena-backend';
import * as globalEventBus from '~/src/event-bus';
import { configJsonPath } from '~/lib/constants';
import { waitFor } from '~/test-lib/helper';

describe('logging', () => {
	let assignFieldsSpy: SinonSpy;
	let testFs: TestFs.Enabled;

	before(async () => {
		// Keep config.json so provisioning values set by the tests are reverted
		testFs = await testfs({}, { keep: [configJsonPath] }).enable();
		assignFieldsSpy = spy(BalenaLogBackend.prototype, 'assignFields');
		await config.initialized();
	});

	after(async () => {
		assignFieldsSpy.restore();
		await testFs.restore();
	});

	it('does not configure the balena backend before the device is provisioned', async () => {
		// The uuid and device API key are generated before provisioning
		const { provisioned, uuid, deviceApiKey } = await config.getMany([
			'provisioned',
			'uuid',
			'deviceApiKey',
		]);
		expect(provisioned).to.be.false;
		expect(uuid).to.not.be.empty;
		expect(deviceApiKey).to.not.be.empty;

		await logger.initialized();
		expect(assignFieldsSpy).to.not.have.been.called;
	});

	it('configures the balena backend with the API endpoint once provisioned if no logs endpoint is set', async () => {
		const { apiEndpoint, logsEndpoint, uuid, deviceApiKey } =
			await config.getMany([
				'apiEndpoint',
				'logsEndpoint',
				'uuid',
				'deviceApiKey',
			]);
		expect(logsEndpoint).to.be.undefined;

		await config.set({ registered_at: Date.now(), deviceId: 1 });
		globalEventBus.getInstance().emit('deviceProvisioned');

		await waitFor({ checkFn: () => assignFieldsSpy.called });
		expect(assignFieldsSpy).to.have.been.calledOnceWith(
			apiEndpoint,
			uuid,
			deviceApiKey,
		);
	});
});
