import { expect } from 'chai';
import {
	stub,
	restore,
	spy,
	useFakeTimers,
	SinonStub,
	createSandbox,
} from 'sinon';

import { actions, apiKeys } from '../../../src/device-api';
import * as deviceState from '../../../src/device-state';
import App from '../../../src/compose/app';
import * as applicationManager from '../../../src/compose/application-manager';
import * as serviceManager from '../../../src/compose/service-manager';
import Service from '../../../src/compose/service';
import log from '../../../src/lib/supervisor-console';
import blink = require('../../../src/lib/blink');

import { createContainer, withMockerode } from '../../lib/mockerode';
import * as dbHelper from '../../lib/db-helper';

describe('device-api/actions', () => {
	before(() => {
		// Disable log output during testing
		stub(log, 'debug');
		stub(log, 'warn');
		stub(log, 'info');
		stub(log, 'event');
		stub(log, 'success');
		stub(log, 'error');
	});

	after(() => {
		// Restore sinon stubs
		restore();
	});

	describe('runs healthchecks', () => {
		const taskTrue = () => Promise.resolve(true);
		const taskFalse = () => Promise.resolve(false);
		const taskError = () => {
			throw new Error();
		};

		it('resolves true if all healthchecks pass', async () => {
			expect(await actions.runHealthchecks([taskTrue, taskTrue])).to.be.true;
		});

		it('resolves false if any healthchecks throw an error or fail', async () => {
			expect(await actions.runHealthchecks([taskTrue, taskFalse])).to.be.false;
			expect(await actions.runHealthchecks([taskTrue, taskError])).to.be.false;
			expect(await actions.runHealthchecks([taskFalse, taskError])).to.be.false;
			expect(await actions.runHealthchecks([taskFalse, taskFalse])).to.be.false;
			expect(await actions.runHealthchecks([taskError, taskError])).to.be.false;
		});
	});

	describe('identifies device', () => {
		it('directs device to blink for set duration', async () => {
			const blinkStartSpy = spy(blink.pattern, 'start');
			const blinkStopSpy = spy(blink.pattern, 'stop');
			const clock = useFakeTimers();

			actions.identify();
			expect(blinkStartSpy.callCount).to.equal(1);
			clock.tick(15000);
			expect(blinkStopSpy.callCount).to.equal(1);

			blinkStartSpy.restore();
			blinkStopSpy.restore();
			clock.restore();
		});
	});

	describe('regenerates Supervisor API key', () => {
		let reportStateStub: SinonStub;

		beforeEach(() => {
			reportStateStub = stub(deviceState, 'reportCurrentState');
		});
		afterEach(() => reportStateStub.restore());

		it("communicates new key to cloud if it's a cloud key", async () => {
			const cloudKey = await apiKeys.generateCloudKey();
			const newKey = await actions.regenerateKey(cloudKey);
			expect(cloudKey).to.not.equal(newKey);
			expect(newKey).to.equal(apiKeys.cloudApiKey);
			expect(reportStateStub).to.have.been.calledOnce;
			expect(reportStateStub.firstCall.args[0]).to.deep.equal({
				api_secret: newKey,
			});
		});

		it("doesn't communicate new key if it's a service key", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			const newKey = await actions.regenerateKey(scopedKey);
			expect(scopedKey).to.not.equal(newKey);
			expect(newKey).to.not.equal(apiKeys.cloudApiKey);
			expect(reportStateStub).to.not.have.been.called;
		});
	});

	describe('restarts an application', () => {
		const sandbox = createSandbox();
		let getCurrentAppsStub: SinonStub;
		let killServiceStub: SinonStub;
		let startServiceStub: SinonStub;
		let testDb: dbHelper.TestDatabase;

		const appId = 1234567;
		const appUuid = 'deadbeef';
		const commit = 'commit';

		// Set up mockerode containers & services
		const serviceData = [
			{ id: 1, name: 'one', containerId: 'ctn1', imageId: 4, releaseId: 7 },
			{ id: 2, name: 'two', containerId: 'ctn2', imageId: 5, releaseId: 8 },
			{ id: 3, name: 'thr', containerId: 'ctn3', imageId: 6, releaseId: 9 },
		];
		const containers = serviceData.map((service) =>
			createContainer({
				Id: service.containerId,
				Name: `${service.name}_${service.imageId}_${service.releaseId}_${commit}`,
				Config: {
					Labels: {
						'io.balena.app-id': String(appId),
						'io.balena.app-uuid': appUuid,
						'io.balena.architecture': 'aarch64',
						'io.balena.service-id': String(service.id),
						'io.balena.service-name': service.name,
						'io.balena.supervised': 'true',
					},
				},
			}),
		);
		const services = containers.map(({ inspectInfo }) =>
			Service.fromDockerContainer(inspectInfo),
		);

		before(async () => {
			// Multiple database calls occur during restart, so it's easier to
			// set up the entire database instead of stubbing individually
			testDb = await dbHelper.createDB();

			// We don't care about testing clearing volatile state, so stub it
			// to avoid any unintended side effects.
			sandbox
				.stub(applicationManager, 'clearTargetVolatileForServices')
				.resolves();
			getCurrentAppsStub = sandbox.stub(applicationManager, 'getCurrentApps');
			killServiceStub = sandbox.stub(serviceManager, 'kill').resolves();
			startServiceStub = sandbox.stub(serviceManager, 'start').resolves();
		});

		after(async () => {
			// Restore all stubs created using sandbox
			sandbox.restore();

			try {
				await testDb.destroy();
			} catch {
				/* noop */
			}
		});

		afterEach(async () => {
			// Reset history for all stubs created using sandbox
			sandbox.resetHistory();
			await testDb.reset();
		});

		it('restarts all containers in release', async () => {
			getCurrentAppsStub.resolves({
				[appId]: new App(
					{
						appId,
						appUuid,
						commit,
						services,
						volumes: {},
						networks: {},
					},
					false,
				),
			});
			// Perform test with mocked release
			await withMockerode(
				async () => {
					await actions.doRestart(appId);

					expect(killServiceStub).to.have.been.calledThrice;
					expect(startServiceStub).to.have.been.calledThrice;
					services.forEach((svc) => {
						expect(killServiceStub).to.have.been.calledWith(svc);
						expect(startServiceStub).to.have.been.calledWith(svc);
					});
				},
				{ containers },
			);
		});
	});
});
