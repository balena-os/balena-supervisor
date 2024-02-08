import { expect } from 'chai';
import * as path from 'path';
import { promises as fs } from 'fs';
import { testfs } from 'mocha-pod';
import type { TestFs } from 'mocha-pod';
import { setTimeout } from 'timers/promises';

import * as updateLock from '~/lib/update-lock';
import { UpdatesLockedError } from '~/lib/errors';
import * as config from '~/src/config';
import * as lockfile from '~/lib/lockfile';
import { pathOnRoot, pathOnState } from '~/lib/host-utils';
import { mkdirp } from '~/lib/fs-utils';
import { takeGlobalLockRW } from '~/lib/process-lock';

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

	describe('Lock/dispose functionality', () => {
		const testAppId = 1234567;
		const testServiceName = 'test';

		const supportedLockfiles = ['resin-updates.lock', 'updates.lock'];

		const takeLocks = () =>
			Promise.all(
				supportedLockfiles.map((lf) =>
					lockfile.lock(path.join(lockdir(testAppId, testServiceName), lf)),
				),
			);

		const releaseLocks = async () => {
			await Promise.all(
				lockfile.getLocksTaken().map((lock) => lockfile.unlock(lock)),
			);

			// Remove any other lockfiles created for the testAppId
			await Promise.all(
				supportedLockfiles.map((lf) =>
					lockfile.unlock(path.join(lockdir(testAppId, testServiceName), lf)),
				),
			);
		};

		const lockdir = (appId: number, serviceName: string): string =>
			pathOnRoot(updateLock.lockPath(appId, serviceName));

		const expectLocks = async (
			exists: boolean,
			msg?: string,
			appId = testAppId,
			serviceName = testServiceName,
		) =>
			expect(
				fs.readdir(lockdir(appId, serviceName)),
				msg,
			).to.eventually.deep.equal(exists ? supportedLockfiles : []);

		before(async () => {
			await config.initialized();
			await config.set({ lockOverride: false });

			// Ensure the directory is available for all tests
			await fs.mkdir(lockdir(testAppId, testServiceName), {
				recursive: true,
			});
		});

		afterEach(async () => {
			// Cleanup all locks between tests
			await releaseLocks();
		});

		it('should take the lock, run the function, then dispose of locks', async () => {
			await expectLocks(
				false,
				'locks should not exist before the lock is taken',
			);

			await expect(
				updateLock.lock(testAppId, { force: false }, () =>
					// At this point the locks should be taken and not removed
					// until this function has been resolved
					expectLocks(true, 'lockfiles should exist while the lock is active'),
				),
			).to.be.fulfilled;

			await expectLocks(
				false,
				'locks should not exist after the lock is released',
			);
		});

		it('should throw UpdatesLockedError if lockfiles exists', async () => {
			// Take the locks before testing
			await takeLocks();

			await expectLocks(true, 'locks should exist before the lock is taken');

			await updateLock
				.lock(testAppId, { force: false }, () =>
					Promise.reject(
						'the lock function should not invoke the callback if locks are taken',
					),
				)
				.catch((err) => expect(err).to.be.instanceOf(UpdatesLockedError));

			// Since the lock-taking failed, there should be no locks to dispose of
			expect(lockfile.getLocksTaken()).to.have.length(0);

			// Restore the locks that were taken at the beginning of the test
			await releaseLocks();
		});

		it('should dispose of taken locks on any other errors', async () => {
			await expectLocks(false, 'locks should not exist before lock is called');
			await expect(
				updateLock.lock(
					testAppId,
					{ force: false },
					// At this point 2 lockfiles have been written, so this is testing
					// that even if the function rejects, lockfiles will be disposed of
					() =>
						expectLocks(
							true,
							'locks should be owned by the calling function',
						).then(() => Promise.reject('Test error')),
				),
			).to.be.rejectedWith('Test error');

			await expectLocks(
				false,
				'locks should be removed if an error happens within the lock callback',
			);
		});

		it('locks all applications before resolving input function', async () => {
			const appIds = [111, 222, 333];

			// Set up necessary lock directories
			await Promise.all(
				appIds.map((id) =>
					fs.mkdir(lockdir(id, testServiceName), { recursive: true }),
				),
			);

			await expect(
				updateLock.lock(appIds, { force: false }, () =>
					// At this point the locks should be taken and not removed
					// until this function has been resolved
					// Both `updates.lock` and `resin-updates.lock` should have been taken
					Promise.all(
						appIds.map((appId) =>
							expectLocks(
								true,
								`locks for app(${appId}) should exist`,
								appId,
								testServiceName,
							),
						),
					),
				),
			).to.eventually.be.fulfilled;

			// Everything that was locked should have been unlocked after function resolves
			await Promise.all(
				appIds.map((appId) =>
					expectLocks(
						false,
						`locks for app(${appId}) should have been released`,
						appId,
						testServiceName,
					),
				),
			).finally(() =>
				// In case the above fails, we need to make sure to cleanup the lockdir
				Promise.all(
					appIds
						.map((appId) =>
							supportedLockfiles.map((lf) =>
								lockfile.unlock(path.join(lockdir(appId, testServiceName), lf)),
							),
						)
						.flat(),
				),
			);
		});

		it('resolves input function without locking when appId is null', async () => {
			await takeLocks();

			await expect(
				updateLock.lock(null as any, { force: false }, () => Promise.resolve()),
			).to.be.fulfilled;

			await expectLocks(
				true,
				'locks should not be touched by an unrelated lock() call',
			);

			await releaseLocks();
		});

		it('unlocks lockfile to resolve function if force option specified', async () => {
			await takeLocks();

			await expect(
				updateLock.lock(testAppId, { force: true }, () =>
					expectLocks(
						true,
						'locks should be deleted and taken again by the lock() call',
					),
				),
			).to.be.fulfilled;

			await expectLocks(
				false,
				'using force gave lock ownership to the callback, so they should now be deleted',
			);
		});

		it('unlocks lockfile to resolve function if lockOverride option specified', async () => {
			await takeLocks();

			// Change the configuration
			await config.set({ lockOverride: true });

			await expect(
				updateLock.lock(testAppId, { force: false }, () =>
					expectLocks(
						true,
						'locks should be deleted and taken again by the lock() call because of the override',
					),
				),
			).to.be.fulfilled;

			await expectLocks(
				false,
				'using lockOverride gave lock ownership to the callback, so they should now be deleted',
			);
		});
	});

	describe('getServicesLockedByAppId', () => {
		const validPaths = [
			'/tmp/123/one/updates.lock',
			'/tmp/123/two/updates.lock',
			'/tmp/123/three/updates.lock',
			'/tmp/balena-supervisor/services/456/server/updates.lock',
			'/tmp/balena-supervisor/services/456/client/updates.lock',
			'/tmp/balena-supervisor/services/789/main/resin-updates.lock',
		];
		const invalidPaths = [
			'/tmp/balena-supervisor/services/456/updates.lock',
			'/tmp/balena-supervisor/services/server/updates.lock',
			'/tmp/test/updates.lock',
		];
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs({ '/tmp': {} }).enable();
			// TODO: mocha-pod should support empty directories
			await Promise.all(
				validPaths
					.concat(invalidPaths)
					.map((p) => fs.mkdir(path.dirname(p), { recursive: true })),
			);
		});
		afterEach(async () => {
			await Promise.all(
				validPaths
					.concat(invalidPaths)
					.map((p) => fs.rm(path.dirname(p), { recursive: true })),
			);
			await tFs.restore();
		});

		it('should return locks taken by appId', async () => {
			// Set up lockfiles
			await Promise.all(
				validPaths.map((p) => lockfile.lock(p, updateLock.LOCKFILE_UID)),
			);

			const locksTakenMap = updateLock.getServicesLockedByAppId();
			expect([...locksTakenMap.keys()]).to.deep.include.members([
				123, 456, 789,
			]);
			// Should register as locked if only `updates.lock` is present
			expect(locksTakenMap.getServices(123)).to.deep.include.members([
				'one',
				'two',
				'three',
			]);
			expect(locksTakenMap.getServices(456)).to.deep.include.members([
				'server',
				'client',
			]);
			// Should register as locked if only `resin-updates.lock` is present
			expect(locksTakenMap.getServices(789)).to.deep.include.members(['main']);

			// Cleanup lockfiles
			await Promise.all(validPaths.map((p) => lockfile.unlock(p)));
		});

		it('should ignore invalid lockfile locations', async () => {
			// Set up lockfiles
			await Promise.all(invalidPaths.map((p) => lockfile.lock(p)));

			expect(updateLock.getServicesLockedByAppId().size).to.equal(0);

			// Cleanup lockfiles
			await Promise.all(invalidPaths.map((p) => lockfile.unlock(p)));
		});
	});

	describe('composition step actions', () => {
		const lockdir = pathOnRoot(updateLock.BASE_LOCK_DIR);
		const serviceLockPaths = {
			1: [
				`${lockdir}/1/server/updates.lock`,
				`${lockdir}/1/server/resin-updates.lock`,
				`${lockdir}/1/client/updates.lock`,
				`${lockdir}/1/client/resin-updates.lock`,
			],
			2: [
				`${lockdir}/2/main/updates.lock`,
				`${lockdir}/2/main/resin-updates.lock`,
			],
		};

		describe('takeLock', () => {
			// TODO
		});

		describe('releaseLock', () => {
			let testFs: TestFs.Enabled;

			beforeEach(async () => {
				testFs = await testfs(
					{},
					{ cleanup: [path.join(lockdir, '*', '*', '**.lock')] },
				).enable();
				// TODO: Update mocha-pod to work with creating empty directories
				await mkdirp(`${lockdir}/1/server`);
				await mkdirp(`${lockdir}/1/client`);
				await mkdirp(`${lockdir}/2/main`);
			});

			afterEach(async () => {
				await testFs.restore();
				await fs.rm(`${lockdir}/1`, { recursive: true });
				await fs.rm(`${lockdir}/2`, { recursive: true });
			});

			it('releases locks for an appId', async () => {
				// Lock services for appId 1
				for (const lockPath of serviceLockPaths[1]) {
					await lockfile.lock(lockPath);
				}
				// Sanity check that locks are taken & tracked by Supervisor
				expect(lockfile.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				// Release locks for appId 1
				await updateLock.releaseLock(1);
				// Locks should have been released
				expect(lockfile.getLocksTaken()).to.have.length(0);
				// Double check that the lockfiles are removed
				expect(await fs.readdir(`${lockdir}/1/server`)).to.have.length(0);
				expect(await fs.readdir(`${lockdir}/1/client`)).to.have.length(0);
			});

			it('does not error if there are no locks to release', async () => {
				expect(lockfile.getLocksTaken()).to.have.length(0);
				// Should not error
				await updateLock.releaseLock(1);
				expect(lockfile.getLocksTaken()).to.have.length(0);
			});

			it('ignores locks outside of appId scope', async () => {
				const lockPath = `${lockdir}/2/main/updates.lock`;
				// Lock services outside of appId scope
				await lockfile.lock(lockPath);
				// Sanity check that locks are taken & tracked by Supervisor
				expect(lockfile.getLocksTaken()).to.deep.include.members([lockPath]);
				// Release locks for appId 1
				await updateLock.releaseLock(1);
				// Locks for appId 2 should not have been released
				expect(lockfile.getLocksTaken()).to.deep.include.members([lockPath]);
				// Double check that the lockfile is still there
				expect(await fs.readdir(`${lockdir}/2/main`)).to.have.length(1);
				// Clean up the lockfile
				await lockfile.unlock(lockPath);
			});

			it('waits to release locks until resource write lock is taken', async () => {
				// Lock services for appId 1
				for (const lockPath of serviceLockPaths[1]) {
					await lockfile.lock(lockPath);
				}
				// Sanity check that locks are taken & tracked by Supervisor
				expect(lockfile.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				// Take the write lock for appId 1
				const release = await takeGlobalLockRW(1);
				// Queue releaseLock, won't resolve until the write lock is released
				const releaseLockPromise = updateLock.releaseLock(1);
				// Locks should have not been released even after waiting
				await setTimeout(500);
				expect(lockfile.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				// Release the write lock
				release();
				// Release locks for appId 1 should resolve
				await releaseLockPromise;
				// Locks should have been released
				expect(lockfile.getLocksTaken()).to.have.length(0);
			});
		});
	});
});
