import { expect } from 'chai';
import * as path from 'path';
import { promises as fs } from 'fs';
import { setTimeout } from 'timers/promises';
import { testfs } from 'mocha-pod';

import * as updateLock from '~/lib/update-lock';
import { Lockable } from '~/lib/update-lock';
import { isENOENT, UpdatesLockedError } from '~/lib/errors';
import { pathOnRoot, pathOnState } from '~/lib/host-utils';

describe('lib/update-lock', () => {
	describe('abortIfHUPInProgress', () => {
		const breadcrumbFiles = [
			'rollback-health-breadcrumb',
			'rollback-altboot-breadcrumb',
		];

		const breadcrumbsDir = pathOnState();

		const createBreadcrumb = (breadcrumb: string) =>
			testfs({
				[path.join(breadcrumbsDir, breadcrumb)]: '',
			}).enable();

		before(async () => {
			// Ensure the directory exists for all tests
			await fs.mkdir(breadcrumbsDir, { recursive: true });
		});

		it('should throw if any breadcrumbs exist on host', async () => {
			for (const bc of breadcrumbFiles) {
				const testFs = await createBreadcrumb(bc);
				await expect(updateLock.abortIfHUPInProgress({ force: false }))
					.to.eventually.be.rejectedWith('Waiting for Host OS update to finish')
					.and.be.an.instanceOf(UpdatesLockedError);
				await testFs.restore();
			}
		});

		it('should resolve to false if no breadcrumbs on host', async () => {
			// check that there are no breadcrumbs already on the directory
			expect(await fs.readdir(breadcrumbsDir)).to.have.lengthOf(0);
			await expect(
				updateLock.abortIfHUPInProgress({ force: false }),
			).to.eventually.equal(false);
		});

		it('should resolve to true if breadcrumbs are on host but force is passed', async () => {
			for (const bc of breadcrumbFiles) {
				const testFs = await createBreadcrumb(bc);
				await expect(
					updateLock.abortIfHUPInProgress({ force: true }),
				).to.eventually.equal(true);
				await testFs.restore();
			}
		});
	});

	const lockdir = (appId: number | string, serviceName: string): string =>
		pathOnRoot(updateLock.lockPath(appId, serviceName));

	async function expectLocks(
		appId: string | number,
		services: string[],
		exists = true,
		msg = `expect lock to ${exists ? 'exist' : 'not exist'}`,
	) {
		for (const svcName of services) {
			const svcMsg = `${svcName}: ${msg}`;
			try {
				const contents = await fs.readdir(lockdir(appId, svcName));
				if (exists) {
					expect(contents, svcMsg).to.have.members([
						'resin-updates.lock',
						'updates.lock',
					]);
				} else {
					expect(contents, svcMsg).to.deep.equal([]);
				}
			} catch (e) {
				if (!isENOENT(e)) {
					throw e;
				}

				if (exists) {
					expect.fail(svcMsg);
				}
			}
		}
	}

	describe('Lockable', () => {
		afterEach(async () => {
			await fs.rm(pathOnRoot('/tmp/balena-supervisor/services/123'), {
				recursive: true,
				force: true,
			});
		});

		it('allows to lock a specific app by id and the given services', async () => {
			// No locks before locking takes place
			await expectLocks(123, ['one', 'two'], false);

			const lockable = Lockable.from(123, ['one', 'two']);

			const lock = await lockable.lock();
			// Locks should exist now
			await expectLocks(123, ['one', 'two']);

			await lock.unlock();

			// Locks should have been removed
			await expectLocks(123, ['one', 'two'], false);
		});

		it('allows only one app lock to be taken at a time', async () => {
			// No locks before locking takes place
			await expectLocks(123, ['one', 'two'], false);

			const lockable = Lockable.from(123, ['one', 'two']);

			const lock = await lockable.lock();
			// Locks should exist now
			await expectLocks(123, ['one', 'two']);

			// Try to take the lock again. Set a timeout of 10ms
			await expect(lockable.lock({ maxWaitMs: 10 })).to.be.rejectedWith(
				'Locks for app 123 are being held by another supervisor operation',
			);

			await lock.unlock();

			// Locks should have been removed
			await expectLocks(123, ['one', 'two'], false);
		});

		it('creates only missing locks', async () => {
			const serviceLock = path.join(lockdir(123, 'two'), 'resin-updates.lock');
			const tmp = await testfs({
				[serviceLock]: testfs.file({ uid: updateLock.LOCKFILE_UID }),
			}).enable();

			const lockable = Lockable.from(123, ['one', 'two']);

			// Locking should succeed
			const lock = await lockable.lock();

			// Locks should exist now
			await expectLocks(123, ['one', 'two']);

			await lock.unlock();

			// Locks should have been removed
			await expectLocks(123, ['one', 'two'], false);
			await tmp.restore();
		});

		it('throws UpdatesLockedError if user held lockfiles exist', async () => {
			const serviceLock = path.join(lockdir(123, 'two'), 'resin-updates.lock');
			const tmp = await testfs({
				[serviceLock]: testfs.file({ uid: 0 }),
			}).enable();

			const lockable = Lockable.from(123, ['one', 'two']);

			// Locking should fail
			await expect(lockable.lock()).to.be.rejectedWith(
				'Lockfile exists for { appId: 123, service: two }',
			);

			// Supervisor locks should not exist
			await expect(fs.readdir(lockdir(123, 'one'))).to.eventually.deep.equal(
				[],
			);
			await expect(fs.readdir(lockdir(123, 'two'))).to.eventually.deep.equal([
				'resin-updates.lock',
			]);
			await tmp.restore();
		});

		it('takes locks if `force` is used', async () => {
			const serviceLock = path.join(lockdir(123, 'two'), 'resin-updates.lock');
			const tmp = await testfs({
				[serviceLock]: testfs.file({ uid: 0 }),
			}).enable();

			const lockable = Lockable.from(123, ['one', 'two']);

			// Locking should succeed
			const lock = await lockable.lock({ force: true });

			// Locks should exist now
			await expectLocks(123, ['one', 'two']);

			await lock.unlock();

			// All should have been removed now
			await expectLocks(123, ['one', 'two'], false);
			await tmp.restore();
		});

		it('disposes supervisor locks if there are user held locks', async () => {
			const svLock = path.join(lockdir(123, 'two'), 'resin-updates.lock');
			const userLock = path.join(lockdir(123, 'two'), 'updates.lock');
			const tmp = await testfs({
				[svLock]: testfs.file({ uid: updateLock.LOCKFILE_UID }),
				[userLock]: testfs.file({ uid: 0 }),
			}).enable();

			const lockable = Lockable.from(123, ['one', 'two']);

			// Locking should fail
			await expect(lockable.lock()).to.be.rejected;

			// Supervisor locks should not exist
			await expect(fs.readdir(lockdir(123, 'one'))).to.eventually.deep.equal(
				[],
			);

			// Only the user lock remains
			await expect(fs.readdir(lockdir(123, 'two'))).to.eventually.deep.equal([
				'updates.lock',
			]);
			await tmp.restore();
		});
	});

	describe('withLock', () => {
		afterEach(async () => {
			await fs.rm(pathOnRoot('/tmp/balena-supervisor/services/123'), {
				recursive: true,
				force: true,
			});
		});

		it('should take the lock, run the function, then dispose of locks', async () => {
			// Create some empty directories to simulate two services
			await fs.mkdir(lockdir(123, 'one'), { recursive: true });
			await fs.mkdir(lockdir(123, 'two'), { recursive: true });

			// No locks before locking takes place
			await expectLocks(123, ['one', 'two'], false);

			await expect(
				updateLock.withLock(123, () =>
					// At this point the locks should be taken and not removed
					// until this function has been resolved
					expectLocks(123, ['one', 'two']),
				),
			).to.be.fulfilled;

			// Locks should be removed after
			await expectLocks(123, ['one', 'two'], false);
		});

		it('should throw UpdatesLockedError if lockfiles exists', async () => {
			// Take the locks before testing
			// TODO: enable mocha-pod to work with empty directories
			await fs.mkdir(lockdir(123, 'one'), { recursive: true });
			const serviceLock = path.join(lockdir(123, 'two'), 'resin-updates.lock');
			const tmp = await testfs({
				[serviceLock]: testfs.file({ uid: 0 }),
			}).enable();

			await expect(
				updateLock.withLock(123, () => expect.fail('This is the wrong error')),
			).to.be.rejectedWith('Lockfile exists for { appId: 123, service: two }');

			// Supervisor locks should not exist
			await expect(fs.readdir(lockdir(123, 'one'))).to.eventually.deep.equal(
				[],
			);
			await expect(fs.readdir(lockdir(123, 'two'))).to.eventually.deep.equal([
				'resin-updates.lock',
			]);

			// Restore the locks that were taken at the beginning of the test
			await tmp.restore();
		});

		it('should dispose of taken locks on any other errors', async () => {
			// Create some empty directories to simulate two services
			await fs.mkdir(lockdir(123, 'one'), { recursive: true });
			await fs.mkdir(lockdir(123, 'two'), { recursive: true });

			// No locks before locking takes place
			await expectLocks(123, ['one', 'two'], false);

			await expect(
				updateLock.withLock(123, async () => {
					await expectLocks(123, ['one', 'two']);
					throw new Error('This is an error');
				}),
			).to.be.rejectedWith('This is an error');

			// Locks should not exist
			await expectLocks(123, ['one', 'two'], false);
		});

		it('locks all applications before resolving input function', async () => {
			const appIds = [111, 222, 333];
			const testServiceName = 'main';

			// Set up necessary lock directories
			await Promise.all(
				appIds.map((id) =>
					fs.mkdir(lockdir(id, testServiceName), { recursive: true }),
				),
			);
			await expect(
				updateLock.withLock(appIds, async () =>
					/// At this point the locks should be taken and not removed
					// until this function has been resolved
					// Both `updates.lock` and `resin-updates.lock` should have been taken
					Promise.all(
						appIds.map((appId) => expectLocks(appId, [testServiceName])),
					),
				),
			).to.be.fulfilled;

			// No locks should exist at this point
			await Promise.all(
				appIds.map((appId) => expectLocks(appId, [testServiceName], false)),
			);

			await Promise.all(
				appIds.map((appId) =>
					fs.rm(pathOnRoot(`/tmp/balena-supervisor/services/${appId}`), {
						recursive: true,
						force: true,
					}),
				),
			);
		});

		it('throws UpdatesLockedError if a lock in any app exist', async () => {
			const appIds = [111, 222, 333];
			const testServiceName = 'main';

			// Set up necessary lock directories
			await Promise.all(
				appIds.map((id) =>
					fs.mkdir(lockdir(id, testServiceName), { recursive: true }),
				),
			);
			const serviceLock = path.join(lockdir(222, 'main'), 'resin-updates.lock');
			const tmp = await testfs({
				[serviceLock]: testfs.file({ uid: 0 }),
			}).enable();

			await expect(
				updateLock.withLock(appIds, async () => {
					throw new Error('This is the wrong error');
				}),
			).to.be.rejectedWith('Lockfile exists for { appId: 222, service: main }');

			// Only the original lock should exist at this point
			await Promise.all(
				[111, 333].map((appId) => expectLocks(appId, [testServiceName], false)),
			);
			await expect(fs.readdir(lockdir(222, 'main'))).to.eventually.deep.equal([
				'resin-updates.lock',
			]);

			// Cleanup
			await tmp.restore();
			await Promise.all(
				appIds.map((appId) =>
					fs.rm(pathOnRoot(`/tmp/balena-supervisor/services/${appId}`), {
						recursive: true,
						force: true,
					}),
				),
			);
		});

		it('allows only one app lock to be taken at a time', async () => {
			// No locks before locking takes place
			await expectLocks(123, ['one', 'two'], false);

			const lockable = Lockable.from(123, ['one', 'two']);

			const lock = await lockable.lock();
			// Locks should exist now
			await expectLocks(123, ['one', 'two']);

			// Try to lock with the function
			await expect(
				updateLock.withLock(123, () => expect.fail('This is the wrong error'), {
					maxWaitMs: 10,
				}),
			).to.be.rejectedWith(
				'Locks for app 123 are being held by another supervisor operation',
			);

			await lock.unlock();

			// Locks should have been removed
			await expectLocks(123, ['one', 'two'], false);
		});

		it('it only allows one withLock call to run at the time', async () => {
			// Create some empty directories to simulate two services
			await fs.mkdir(lockdir(123, 'one'), { recursive: true });
			await fs.mkdir(lockdir(123, 'two'), { recursive: true });

			// No locks before locking takes place
			await expectLocks(123, ['one', 'two'], false);

			// Try to call withLock in parallel for the same app
			const res = await Promise.allSettled([
				updateLock.withLock(123, () => setTimeout(10, 'one'), {
					maxWaitMs: 5,
				}),
				updateLock.withLock(123, () => setTimeout(10, 'two'), {
					maxWaitMs: 5,
				}),
			]);

			expect(res.filter((r) => r.status === 'rejected')).to.have.lengthOf(1);
			expect(res.filter((r) => r.status === 'fulfilled')).to.have.lengthOf(1);

			// Locks should have been removed
			await expectLocks(123, ['one', 'two'], false);
		});
	});

	describe('cleanLocksForApp', () => {
		afterEach(async () => {
			await fs.rm(pathOnRoot('/tmp/balena-supervisor/services/123'), {
				recursive: true,
				force: true,
			});
		});

		it('removes remaining supervisor locks and ignores user locks', async () => {
			const userLock = path.join(lockdir(123, 'one'), 'updates.lock');
			const serviceLock = path.join(lockdir(123, 'two'), 'resin-updates.lock');
			const tmp = await testfs({
				[userLock]: testfs.file({ uid: 0 }),
				[serviceLock]: testfs.file({ uid: updateLock.LOCKFILE_UID }),
			}).enable();

			await updateLock.cleanLocksForApp(123);

			// Supervisor locks should have been removed
			await expect(fs.readdir(lockdir(123, 'two'))).to.eventually.deep.equal(
				[],
			);
			await expect(fs.readdir(lockdir(123, 'one'))).to.eventually.deep.equal([
				'updates.lock',
			]);
			await tmp.restore();
		});

		it('removes remaining supervisor locks and ignores user legacy locks', async () => {
			const userLock = path.join(lockdir(123, 'one'), 'resin-updates.lock');
			const serviceLock = path.join(lockdir(123, 'two'), 'updates.lock');
			const tmp = await testfs({
				[userLock]: testfs.file({ uid: 0 }),
				[serviceLock]: testfs.file({ uid: updateLock.LOCKFILE_UID }),
			}).enable();

			await updateLock.cleanLocksForApp(123);

			// Supervisor locks should have been removed
			await expect(fs.readdir(lockdir(123, 'two'))).to.eventually.deep.equal(
				[],
			);
			await expect(fs.readdir(lockdir(123, 'one'))).to.eventually.deep.equal([
				'resin-updates.lock',
			]);
			await tmp.restore();
		});

		it('ignores locks if taken somewhere else in the supervisor', async () => {
			// No locks before locking takes place
			await expectLocks(123, ['one', 'two'], false);

			const lockable = Lockable.from(123, ['one', 'two']);
			const lock = await lockable.lock();

			// Locks should exist now
			await expectLocks(123, ['one', 'two']);

			// Clean locks should not remove anything
			await expect(updateLock.cleanLocksForApp(123)).to.eventually.equal(false);

			// Locks should still exist
			await expectLocks(123, ['one', 'two']);

			await lock.unlock();
			await expectLocks(123, ['one', 'two'], false);
		});

		it('only removes locks for the given app', async () => {
			const otherLock = path.join(lockdir(456, 'main'), 'updates.lock');
			const serviceLock = path.join(lockdir(123, 'main'), 'resin-updates.lock');
			const tmp = await testfs({
				[otherLock]: testfs.file({ uid: updateLock.LOCKFILE_UID }),
				[serviceLock]: testfs.file({ uid: updateLock.LOCKFILE_UID }),
			}).enable();

			await updateLock.cleanLocksForApp(123);

			// Supervisor locks should have been removed
			await expect(fs.readdir(lockdir(123, 'main'))).to.eventually.deep.equal(
				[],
			);
			await expect(fs.readdir(lockdir(456, 'main'))).to.eventually.deep.equal([
				'updates.lock',
			]);
			await tmp.restore();
		});
	});
});
