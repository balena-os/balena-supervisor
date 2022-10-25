import * as sinon from 'sinon';
import log from '~/lib/supervisor-console';

/**
 * Mocha runs these hooks before/after each test suite (beforeAll/afterAll)
 * or before/after each test (beforeEach/afterEach), the same as with regular test hooks.
 *
 * Do here any setup that needs to affect all tests. When in doubt though, use regular hooks
 * https://mochajs.org/#test-fixture-decision-tree-wizard-thing
 */
export const mochaHooks = {
	beforeAll() {
		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'success');
		sinon.stub(log, 'event');
		sinon.stub(log, 'error');
		sinon.stub(log, 'api');
	},

	afterEach() {
		(log.debug as sinon.SinonStub).reset();
		(log.warn as sinon.SinonStub).reset();
		(log.info as sinon.SinonStub).reset();
		(log.success as sinon.SinonStub).reset();
		(log.event as sinon.SinonStub).reset();
		(log.error as sinon.SinonStub).reset();
		(log.api as sinon.SinonStub).reset();
	},

	afterAll() {
		(log.debug as sinon.SinonStub).restore();
		(log.warn as sinon.SinonStub).restore();
		(log.info as sinon.SinonStub).restore();
		(log.success as sinon.SinonStub).restore();
		(log.event as sinon.SinonStub).restore();
		(log.error as sinon.SinonStub).restore();
		(log.api as sinon.SinonStub).restore();
	},
};
