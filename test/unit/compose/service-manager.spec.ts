import { expect } from 'chai';
import * as sinon from 'sinon';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as serviceManager from '~/src/compose/service-manager';
import * as logger from '~/src/logging';
import { createService } from '~/test-lib/state-helper';
import { createContainer, withMockerode } from '~/test-lib/mockerode';

// Matches what createService below builds, so the container reads back as the
// same service it was created from
const SERVICE_LABELS = {
	'io.balena.supervised': 'true',
	'io.balena.app-id': '1',
	'io.balena.app-uuid': 'appuuid',
	'io.balena.service-id': '1',
	'io.balena.service-name': 'main',
};

describe('compose/service-manager', () => {
	before(() => {
		sinon.stub(logger, 'logSystemEvent');
	});

	after(() => {
		(logger.logSystemEvent as sinon.SinonStub).restore();
	});

	describe('removing a dead service', () => {
		const createDeadService = (containerId = 'deadbeef') =>
			createService({}, { state: { containerId, status: 'Dead' } });

		const createDeadContainer = (
			Id = 'deadbeef',
			extra: Parameters<typeof createContainer>[0] = { Id },
		) =>
			createContainer({
				Name: 'main_1_1_main-commit',
				State: { Status: 'dead', Running: false },
				Config: { Labels: SERVICE_LABELS },
				...extra,
				Id,
			});

		it('removes the container the step was generated for', async () => {
			const service = await createDeadService();

			await withMockerode(
				async (mockerode) => {
					await serviceManager.remove(service);

					expect(mockerode.getContainer).to.have.been.calledWith('deadbeef');
					expect(await mockerode.listContainers()).to.have.lengthOf(0);
				},
				{ containers: [createDeadContainer()] },
			);
		});

		// The step is emitted from a snapshot of the current state, so by the time
		// it runs the Engine may have finished removing the container itself
		it('succeeds when the container is already gone', async () => {
			const service = await createDeadService();

			await withMockerode(async () => {
				await expect(serviceManager.remove(service)).to.not.be.rejected;
			});
		});

		// A container part way through removal has had its networks detached, so
		// it no longer matches the definition it was read from
		it('removes a container that no longer matches its own configuration', async () => {
			const service = await createDeadService();

			await withMockerode(
				async (mockerode) => {
					await serviceManager.remove(service);

					expect(await mockerode.listContainers()).to.have.lengthOf(0);
				},
				{
					containers: [
						createDeadContainer('deadbeef', {
							Id: 'deadbeef',
							NetworkSettings: { Networks: {} },
						}),
					],
				},
			);
		});

		// A dead container is one the Engine has already failed to remove once
		it('forces removal, along with the container volumes', async () => {
			const service = await createDeadService();
			const remove = sinon.stub().resolves();

			await withMockerode(async (mockerode) => {
				mockerode.getContainer.returns({ remove } as any);

				await serviceManager.remove(service);

				expect(remove).to.have.been.calledWith({ v: true, force: true });
			});
		});

		it('reports any other removal failure', async () => {
			const service = await createDeadService();

			await withMockerode(async (mockerode) => {
				mockerode.getContainer.returns({
					remove: () =>
						Promise.reject(
							Object.assign(new Error('device or resource busy'), {
								statusCode: 500,
							}),
						),
				} as any);

				await expect(serviceManager.remove(service)).to.be.rejected;
			});
		});
	});

	describe('waiting for a handover', () => {
		let dir: string;
		let service: Awaited<ReturnType<typeof createService>>;

		beforeEach(async () => {
			dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-'));
			service = await createService({});
			sinon
				.stub(service, 'handoverCompleteFullPathsOnHost')
				.returns([
					path.join(dir, 'handover-complete'),
					path.join(dir, 'resin-kill-me'),
				]);
		});

		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true });
		});

		it('waits until the new service signals that the handover is complete', async () => {
			const signal = path.join(dir, 'handover-complete');
			setTimeout(() => void fs.writeFile(signal, ''), 300);

			const start = Date.now();
			await serviceManager.waitToKill(service, 5000);

			expect(Date.now() - start).to.be.at.least(300);
			await expect(fs.stat(signal)).to.be.rejected;
		});

		it('accepts the legacy resin-kill-me path', async () => {
			setTimeout(
				() => void fs.writeFile(path.join(dir, 'resin-kill-me'), ''),
				300,
			);

			const start = Date.now();
			await serviceManager.waitToKill(service, 5000);

			expect(Date.now() - start).to.be.at.least(300);
		});

		it('gives up once the timeout has passed', async () => {
			const start = Date.now();
			await serviceManager.waitToKill(service, 300);

			expect(Date.now() - start).to.be.at.least(300);
		});
	});
});
