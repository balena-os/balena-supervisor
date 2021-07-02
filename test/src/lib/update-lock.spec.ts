import { expect } from 'chai';
import { SinonSpy, SinonStub, spy, stub } from 'sinon';
import * as path from 'path';
import * as Bluebird from 'bluebird';

import rewire = require('rewire');
import mockFs = require('mock-fs');

import * as constants from '../../../src/lib/constants';
import { UpdatesLockedError } from '../../../src/lib/errors';

describe('lib/update-lock', () => {
	const updateLock = rewire('../../../src/lib/update-lock');
	const breadcrumbFiles = [
		'rollback-health-breadcrumb',
		'rollback-altboot-breadcrumb',
	];

	const mockBreadcrumbs = (breadcrumb?: string) => {
		mockFs({
			[path.join(
				constants.rootMountPoint,
				constants.stateMountPoint,
				breadcrumb ? breadcrumb : '',
			)]: '',
		});
	};

	const mockLockDir = ({
		appId,
		service,
		createLockfile = true,
	}: {
		appId: number;
		service: string;
		createLockfile?: boolean;
	}) => {
		mockFs({
			[path.join(
				constants.rootMountPoint,
				updateLock.lockPath(appId),
				service,
			)]: {
				[createLockfile ? 'updates.lock' : 'ignore-this.lock']: '',
			},
		});
	};

	// TODO: Remove these hooks when we don't need './test/data' as test process's rootMountPoint
	before(() => {
		// @ts-ignore // Set rootMountPoint for mockFs
		constants.rootMountPoint = '/mnt/root';
	});

	after(() => {
		// @ts-ignore
		constants.rootMountPoint = process.env.ROOT_MOUNTPOINT;
	});

	describe('Lockfile path methods', () => {
		const testAppId = 1234567;
		const testService = 'test';

		it('should return path prefix of service lockfiles on host', () => {
			expect(updateLock.lockPath(testAppId)).to.equal(
				`/tmp/balena-supervisor/services/${testAppId}`,
			);
			expect(updateLock.lockPath(testAppId, testService)).to.equal(
				`/tmp/balena-supervisor/services/${testAppId}/${testService}`,
			);
		});

		it('should return the complete paths of (non-)legacy lockfiles on host', () => {
			const lockFilesOnHost = updateLock.__get__('lockFilesOnHost');
			expect(lockFilesOnHost(testAppId, testService)).to.deep.equal([
				`${constants.rootMountPoint}/tmp/balena-supervisor/services/${testAppId}/${testService}/updates.lock`,
				`${constants.rootMountPoint}/tmp/balena-supervisor/services/${testAppId}/${testService}/resin-updates.lock`,
			]);
		});
	});

	describe('abortIfHUPInProgress', () => {
		afterEach(() => mockFs.restore());

		it('should throw if any breadcrumbs exist on host', async () => {
			for (const bc of breadcrumbFiles) {
				mockBreadcrumbs(bc);
				await expect(updateLock.abortIfHUPInProgress({ force: false }))
					.to.eventually.be.rejectedWith('Waiting for Host OS update to finish')
					.and.be.an.instanceOf(UpdatesLockedError);
			}
		});

		it('should resolve to false if no breadcrumbs on host', async () => {
			mockBreadcrumbs();
			await expect(
				updateLock.abortIfHUPInProgress({ force: false }),
			).to.eventually.equal(false);
		});

		it('should resolve to true if breadcrumbs are on host but force is passed', async () => {
			for (const bc of breadcrumbFiles) {
				mockBreadcrumbs(bc);
				await expect(
					updateLock.abortIfHUPInProgress({ force: true }),
				).to.eventually.equal(true);
			}
		});
	});

	describe('Lock/dispose functionality', () => {
		const lockFile = updateLock.__get__('lockFile');
		const locksTaken = updateLock.__get__('locksTaken');
		const dispose = updateLock.__get__('dispose');
		const lockExistsErrHandler = updateLock.__get__('lockExistsErrHandler');

		const releaseFn = stub();
		const testLockPaths = ['/tmp/test/1', '/tmp/test/2'];

		let unlockSyncStub: SinonStub;
		let unlockAsyncSpy: SinonSpy;
		let lockAsyncSpy: SinonSpy;

		beforeEach(() => {
			// @ts-ignore
			unlockSyncStub = stub(lockFile, 'unlockSync').callsFake((lockPath) => {
				// Throw error on process.exit for one of the two lockpaths
				if (lockPath === testLockPaths[1]) {
					throw new Error(
						'handled unlockSync error which should not crash test process',
					);
				}
			});
			unlockAsyncSpy = spy(lockFile, 'unlockAsync');
			lockAsyncSpy = spy(lockFile, 'lockAsync');
		});

		afterEach(() => {
			for (const key of Object.keys(locksTaken)) {
				delete locksTaken[key];
			}
			unlockSyncStub.restore();
			unlockAsyncSpy.restore();
			lockAsyncSpy.restore();
		});

		it('should try to clean up existing locks on process exit', () => {
			testLockPaths.forEach((p) => (locksTaken[p] = true));

			// @ts-ignore
			process.emit('exit');
			testLockPaths.forEach((p) => {
				expect(unlockSyncStub).to.have.been.calledWith(p);
			});
		});

		it('should dispose of locks', async () => {
			for (const lock of testLockPaths) {
				locksTaken[lock] = true;
			}

			await dispose(releaseFn);

			expect(locksTaken).to.deep.equal({});
			expect(releaseFn).to.have.been.called;
			testLockPaths.forEach((p) => {
				expect(unlockAsyncSpy).to.have.been.calledWith(p);
			});
		});

		describe('lockExistsErrHandler', () => {
			it('should handle EEXIST', async () => {
				const appIdentifiers = [
					{ id: '1234567', service: 'test1', type: 'appId' },
					{
						id: 'c89a7cb83d974518479591ffaf7c2417',
						service: 'test2',
						type: 'appUuid',
					},
					{ id: 'c89a7cb', service: 'test3', type: 'appUuid' },
				];
				for (const { id, service, type } of appIdentifiers) {
					// Handle legacy & nonlegacy lockfile names
					for (const lockfile of ['updates.lock', 'resin-updates.lock']) {
						const error = {
							code: 'EEXIST',
							message: `EEXIST: open "/tmp/balena-supervisor/services/${id}/${service}/${lockfile}"`,
						};
						await expect(lockExistsErrHandler(error, releaseFn))
							.to.eventually.be.rejectedWith(
								`Lockfile exists for ${JSON.stringify({
									serviceName: service,
									[type]: id,
								})}`,
							)
							.and.be.an.instanceOf(UpdatesLockedError);
					}
				}
			});

			it('should handle any other errors', async () => {
				await expect(lockExistsErrHandler(new Error('Test error'), releaseFn))
					.to.eventually.be.rejectedWith('Test error')
					.and.be.an.instanceOf(UpdatesLockedError);
			});
		});

		describe('lock', () => {
			let bluebirdUsing: SinonSpy;
			let bluebirdResolve: SinonSpy;
			const lockParamFn = stub().resolves();

			beforeEach(() => {
				bluebirdUsing = spy(Bluebird, 'using');
				bluebirdResolve = spy(Bluebird, 'resolve');
			});

			afterEach(() => {
				bluebirdUsing.restore();
				bluebirdResolve.restore();

				mockFs.restore();
			});

			it('resolves input function without dispose pattern when appId is null', async () => {
				mockLockDir({ appId: 1234567, service: 'test', createLockfile: true });
				await expect(updateLock.lock(null, { force: false }, lockParamFn)).to.be
					.fulfilled;
				expect(bluebirdResolve).to.have.been.called;
			});

			it('resolves input function without dispose pattern when no lockfiles exist', async () => {
				mockLockDir({ appId: 1234567, service: 'test', createLockfile: false });
				await expect(updateLock.lock(1234567, { force: false }, lockParamFn)).to
					.be.fulfilled;
				expect(bluebirdResolve).to.have.been.called;
			});

			it('uses dispose pattern if lockfile present and throws error', async () => {
				mockLockDir({ appId: 1234567, service: 'test' });
				await expect(updateLock.lock(1234567, { force: false }, lockParamFn))
					.to.eventually.be.rejectedWith(
						'Lockfile exists for {"serviceName":"test","appId":"1234567"}',
					)
					.and.be.an.instanceOf(UpdatesLockedError);
				expect(lockAsyncSpy).to.have.been.called;
				expect(bluebirdUsing).to.have.been.called;
			});

			it('unlocks lockfile to resolve function if force option specified', async () => {
				mockLockDir({ appId: 1234567, service: 'test' });
				await expect(updateLock.lock(1234567, { force: true }, lockParamFn)).to
					.be.fulfilled;
				expect(unlockAsyncSpy).to.have.been.called;
				expect(lockAsyncSpy).to.have.been.called;
				expect(bluebirdUsing).to.have.been.called;
			});
		});
	});
});
