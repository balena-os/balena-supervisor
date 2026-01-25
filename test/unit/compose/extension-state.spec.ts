import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import * as db from '~/src/db';
import * as extensionState from '~/src/compose/extension-state';

describe('compose/extension-state', () => {
	let modelsStub: SinonStub;
	let upsertModelStub: SinonStub;
	let transactionStub: SinonStub;

	beforeEach(() => {
		modelsStub = stub(db, 'models');
		upsertModelStub = stub(db, 'upsertModel').resolves();
		transactionStub = stub(db, 'transaction').callsFake((fn) => {
			fn({} as db.Transaction);
			return Promise.resolve({} as db.Transaction);
		});
	});

	afterEach(() => {
		modelsStub.restore();
		upsertModelStub.restore();
		transactionStub.restore();
	});

	describe('getDeployedExtensions', () => {
		it('should return empty array when no extensions deployed', async () => {
			modelsStub.returns({
				select: stub().resolves([]),
			});

			const result = await extensionState.getDeployedExtensions();
			expect(result).to.deep.equal([]);
		});

		it('should return deployed extensions from database', async () => {
			modelsStub.returns({
				select: stub().resolves([
					{
						serviceName: 'kernel-modules',
						image: 'registry/kernel-modules:v1',
						imageDigest: null,
						deployedAt: '2024-01-01T00:00:00Z',
					},
				]),
			});

			const result = await extensionState.getDeployedExtensions();
			expect(result).to.have.lengthOf(1);
			expect(result[0]).to.deep.equal({
				serviceName: 'kernel-modules',
				image: 'registry/kernel-modules:v1',
				imageDigest: undefined,
				deployedAt: '2024-01-01T00:00:00Z',
			});
		});
	});

	describe('updateDeployedExtensions', () => {
		it('should insert newly deployed extensions', async () => {
			const delStub = stub().resolves();
			modelsStub.returns({
				where: stub().returns({ del: delStub }),
			});

			await extensionState.updateDeployedExtensions(
				['kernel-modules'],
				[],
				[
					{
						serviceName: 'kernel-modules',
						image: 'registry/kernel-modules:v1',
					},
				],
			);

			expect(upsertModelStub.calledOnce).to.be.true;
			expect(upsertModelStub.firstCall.args[0]).to.equal('extensionState');
			expect(upsertModelStub.firstCall.args[1]).to.include({
				serviceName: 'kernel-modules',
				image: 'registry/kernel-modules:v1',
			});
		});

		it('should remove extensions that were removed', async () => {
			const transactingStub = stub().resolves();
			const delStub = stub().returns({ transacting: transactingStub });
			const whereStub = stub().returns({ del: delStub });
			modelsStub.returns({ where: whereStub });

			await extensionState.updateDeployedExtensions([], ['old-extension'], []);

			expect(whereStub.calledWith({ serviceName: 'old-extension' })).to.be.true;
			expect(delStub.calledOnce).to.be.true;
		});

		it('should handle both deploy and remove in same call', async () => {
			const transactingStub = stub().resolves();
			const delStub = stub().returns({ transacting: transactingStub });
			const whereStub = stub().returns({ del: delStub });
			modelsStub.returns({ where: whereStub });

			await extensionState.updateDeployedExtensions(
				['new-ext'],
				['old-ext'],
				[{ serviceName: 'new-ext', image: 'registry/new:v1' }],
			);

			expect(delStub.calledOnce).to.be.true;
			expect(upsertModelStub.calledOnce).to.be.true;
		});
	});
});
