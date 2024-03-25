import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import * as process from 'process';

import * as memory from '~/src/memory';
import * as deviceState from '~/src/device-state';
import log from '~/lib/supervisor-console';

describe('memory.healthcheck', () => {
	let uptimeStub: SinonStub;
	let rssStub: SinonStub;
	let isApplyInProgressStub: SinonStub;

	beforeEach(() => {
		uptimeStub = stub(process, 'uptime').returns(20);
		rssStub = stub(process.memoryUsage, 'rss').returns(100);
		isApplyInProgressStub = stub(deviceState, 'isApplyInProgress').returns(
			false,
		);
	});

	afterEach(() => {
		uptimeStub.restore();
		rssStub.restore();
		isApplyInProgressStub.restore();
	});

	it('passes healthcheck if process has not been running for 20s', async () => {
		// @ts-expect-error
		memory.initialMemory = 0;
		uptimeStub.returns(19);

		expect(await memory.healthcheck()).to.be.true;
	});

	it('passes healthcheck while initial memory not set and sets initial memory', async () => {
		// @ts-expect-error
		memory.initialMemory = 0;

		expect(await memory.healthcheck()).to.be.true;
		expect(memory.initialMemory).to.equal(100);
	});

	it('passes healthcheck while state apply in progress', async () => {
		// @ts-expect-error
		memory.initialMemory = 100;
		isApplyInProgressStub.returns(true);

		expect(await memory.healthcheck()).to.be.true;
	});

	it('passes healthcheck if memory usage is below threshold', async () => {
		// @ts-expect-error
		memory.initialMemory = 100;
		rssStub.returns(150);

		expect(await memory.healthcheck(100)).to.be.true;
	});

	it('fails healthcheck if memory usage is above threshold', async () => {
		// @ts-expect-error
		memory.initialMemory = 100;
		uptimeStub.returns(61);
		rssStub.returns(250);

		expect(await memory.healthcheck(100)).to.be.false;
		expect(log.info).to.have.been.calledWith(
			`Healthcheck failure - memory usage above threshold after 0h 1m 1s`,
		);
	});
});
