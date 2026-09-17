import { expect } from 'chai';
import * as sinon from 'sinon';

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
});
