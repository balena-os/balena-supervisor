import { expect } from 'chai';
import * as path from 'path';
import { promises as fs } from 'fs';
import { testfs } from 'mocha-pod';
import type { TestFs } from 'mocha-pod';
import { setTimeout } from 'timers/promises';
import { watch } from 'chokidar';

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
					lockfile.lock(
						path.join(lockdir(testAppId, testServiceName), lf),
						updateLock.LOCKFILE_UID,
					),
				),
			);

		const releaseLocks = async () => {
			await Promise.all(
				(await updateLock.getLocksTaken()).map((lock) => lockfile.unlock(lock)),
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

			// Since the lock-taking with `nobody` uid failed, there should be no locks to dispose of
			expect(await updateLock.getLocksTaken()).to.have.length(0);

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

	describe('getLocksTaken', () => {
		const lockdir = pathOnRoot(updateLock.BASE_LOCK_DIR);
		before(async () => {
			await testfs({
				[lockdir]: {},
			}).enable();
			// TODO: enable mocha-pod to work with empty directories
			await fs.mkdir(`${lockdir}/123/main`, { recursive: true });
			await fs.mkdir(`${lockdir}/123/aux`, { recursive: true });
			await fs.mkdir(`${lockdir}/123/invalid`, { recursive: true });
		});
		after(async () => {
			await fs.rm(`${lockdir}/123`, { recursive: true });
			await testfs.restore();
		});

		it('resolves with all locks taken with the Supervisor lockfile UID', async () => {
			// Set up valid lockfiles including some directories
			await Promise.all(
				['resin-updates.lock', 'updates.lock'].map((lf) => {
					const p = `${lockdir}/123/main/${lf}`;
					return fs
						.mkdir(p)
						.then(() =>
							fs.chown(p, updateLock.LOCKFILE_UID, updateLock.LOCKFILE_UID),
						);
				}),
			);
			await Promise.all([
				lockfile.lock(
					`${lockdir}/123/aux/updates.lock`,
					updateLock.LOCKFILE_UID,
				),
				lockfile.lock(
					`${lockdir}/123/aux/resin-updates.lock`,
					updateLock.LOCKFILE_UID,
				),
			]);

			// Set up invalid lockfiles with root UID
			await Promise.all(
				['resin-updates.lock', 'updates.lock'].map((lf) =>
					lockfile.lock(`${lockdir}/123/invalid/${lf}`),
				),
			);

			const locksTaken = await updateLock.getLocksTaken();
			expect(locksTaken).to.have.length(4);
			expect(locksTaken).to.deep.include.members([
				`${lockdir}/123/aux/resin-updates.lock`,
				`${lockdir}/123/aux/updates.lock`,
				`${lockdir}/123/main/resin-updates.lock`,
				`${lockdir}/123/main/updates.lock`,
			]);
			expect(locksTaken).to.not.deep.include.members([
				`${lockdir}/123/invalid/resin-updates.lock`,
				`${lockdir}/123/invalid/updates.lock`,
			]);
		});
	});

	describe('getServicesLockedByAppId', () => {
		const lockdir = pathOnRoot(updateLock.BASE_LOCK_DIR);
		const validDirs = [
			`${lockdir}/123/one`,
			`${lockdir}/123/two`,
			`${lockdir}/123/three`,
			`${lockdir}/456/server`,
			`${lockdir}/456/client`,
			`${lockdir}/789/main`,
		];
		const validPaths = ['resin-updates.lock', 'updates.lock']
			.map((lf) => validDirs.map((d) => path.join(d, lf)))
			.flat();
		const invalidPaths = [
			// No appId
			`${lockdir}/456/updates.lock`,
			// No service
			`${lockdir}/server/updates.lock`,
			// No appId or service
			`${lockdir}/test/updates.lock`,
			// One of (resin-)updates.lock is missing
			`${lockdir}/123/one/resin-updates.lock`,
			`${lockdir}/123/two/updates.lock`,
		];
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs({
				[lockdir]: {},
			}).enable();
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

			const locksTakenMap = await updateLock.getServicesLockedByAppId();
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
			await Promise.all(
				invalidPaths.map((p) => lockfile.lock(p, updateLock.LOCKFILE_UID)),
			);
			// Take another lock with an invalid UID but with everything else
			// (appId, service, both lockfiles present) correct
			await Promise.all(
				['resin-updates.lock', 'updates.lock'].map((lf) =>
					lockfile.lock(path.join(`${lockdir}/789/main`, lf)),
				),
			);
			expect((await updateLock.getServicesLockedByAppId()).size).to.equal(0);

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
			let testFs: TestFs.Enabled;

			beforeEach(async () => {
				testFs = await testfs(
					{},
					{ cleanup: [path.join(lockdir, '*', '*', '**.lock')] },
				).enable();
				// TODO: Update mocha-pod to work with creating empty directories
				await mkdirp(path.join(lockdir, '1', 'server'));
				await mkdirp(path.join(lockdir, '1', 'client'));
				await mkdirp(path.join(lockdir, '2', 'main'));
			});

			afterEach(async () => {
				await testFs.restore();
				await fs.rm(path.join(lockdir, '1'), { recursive: true });
				await fs.rm(path.join(lockdir, '2'), { recursive: true });
			});

			it('takes locks for a list of services for an appId', async () => {
				// Take locks for appId 1
				await updateLock.takeLock(1, ['server', 'client']);
				// Locks should have been taken
				expect(await updateLock.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				expect(await updateLock.getLocksTaken()).to.have.length(4);
				expect(
					await fs.readdir(path.join(lockdir, '1', 'server')),
				).to.include.members(['updates.lock', 'resin-updates.lock']);
				expect(
					await fs.readdir(path.join(lockdir, '1', 'client')),
				).to.include.members(['updates.lock', 'resin-updates.lock']);
				// Take locks for appId 2
				await updateLock.takeLock(2, ['main']);
				// Locks should have been taken for appid 1 & 2
				expect(await updateLock.getLocksTaken()).to.deep.include.members([
					...serviceLockPaths[1],
					...serviceLockPaths[2],
				]);
				expect(await updateLock.getLocksTaken()).to.have.length(6);
				expect(
					await fs.readdir(path.join(lockdir, '2', 'main')),
				).to.have.length(2);
				// Clean up the lockfiles
				for (const lockPath of serviceLockPaths[1].concat(
					serviceLockPaths[2],
				)) {
					await lockfile.unlock(lockPath);
				}
			});

			it('creates lock directory recursively if it does not exist', async () => {
				// Take locks for app with nonexistent service directories
				await updateLock.takeLock(3, ['api']);
				// Locks should have been taken
				expect(await updateLock.getLocksTaken()).to.deep.include(
					path.join(lockdir, '3', 'api', 'updates.lock'),
					path.join(lockdir, '3', 'api', 'resin-updates.lock'),
				);
				// Directories should have been created
				expect(await fs.readdir(path.join(lockdir))).to.deep.include.members([
					'3',
				]);
				expect(
					await fs.readdir(path.join(lockdir, '3')),
				).to.deep.include.members(['api']);
				// Clean up the lockfiles & created directories
				await lockfile.unlock(path.join(lockdir, '3', 'api', 'updates.lock'));
				await lockfile.unlock(
					path.join(lockdir, '3', 'api', 'resin-updates.lock'),
				);
				await fs.rm(path.join(lockdir, '3'), { recursive: true });
			});

			it('should not take lock for services where Supervisor-taken lock already exists', async () => {
				// Take locks for one service of appId 1
				await lockfile.lock(serviceLockPaths[1][0], updateLock.LOCKFILE_UID);
				await lockfile.lock(serviceLockPaths[1][1], updateLock.LOCKFILE_UID);
				// Sanity check that locks are taken & tracked by Supervisor
				expect(await updateLock.getLocksTaken()).to.deep.include(
					serviceLockPaths[1][0],
					serviceLockPaths[1][1],
				);
				expect(await updateLock.getLocksTaken()).to.have.length(2);
				// Take locks using takeLock, should only lock service which doesn't
				// already have locks
				await expect(
					updateLock.takeLock(1, ['server', 'client']),
				).to.eventually.deep.include.members(['client']);
				// Check that locks are taken
				expect(await updateLock.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				// Clean up lockfiles
				for (const lockPath of serviceLockPaths[1]) {
					await lockfile.unlock(lockPath);
				}
			});

			it('should error if service has a non-Supervisor-taken lock', async () => {
				// Simulate a user service taking the lock for services with appId 1
				for (const lockPath of serviceLockPaths[1]) {
					await fs.writeFile(lockPath, '');
				}
				// Take locks using takeLock, should error
				await expect(
					updateLock.takeLock(1, ['server', 'client']),
				).to.eventually.be.rejectedWith(UpdatesLockedError);
				// No Supervisor locks should have been taken
				expect(await updateLock.getLocksTaken()).to.have.length(0);
				// Clean up user-created lockfiles
				for (const lockPath of serviceLockPaths[1]) {
					await fs.rm(lockPath);
				}
				// Take locks using takeLock, should not error
				await expect(
					updateLock.takeLock(1, ['server', 'client']),
				).to.eventually.not.be.rejectedWith(UpdatesLockedError);
				// Check that locks are taken
				expect(await updateLock.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				expect(await updateLock.getLocksTaken()).to.have.length(4);
				// Clean up lockfiles
				for (const lockPath of serviceLockPaths[1]) {
					await lockfile.unlock(lockPath);
				}
			});

			it('waits to take locks until resource write lock is taken', async () => {
				// Take the write lock for appId 1
				const release = await takeGlobalLockRW(1);
				// Queue takeLock, won't resolve until the write lock is released
				const takeLockPromise = updateLock.takeLock(1, ['server', 'client']);
				// Locks should have not been taken even after waiting
				await setTimeout(500);
				expect(await updateLock.getLocksTaken()).to.have.length(0);
				// Release the write lock
				release();
				// Locks should be taken
				await takeLockPromise;
				// Locks should have been taken
				expect(await updateLock.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
			});

			it('should release locks when takeLock step errors to return services to unlocked state', async () => {
				const svcs = ['server', 'client'];

				// Take lock for second service of two services
				await lockfile.lock(`${lockdir}/1/${svcs[1]}/updates.lock`);
				expect(await lockfile.getLocksTaken(lockdir)).to.deep.include.members([
					`${lockdir}/1/${svcs[1]}/updates.lock`,
				]);

				// Watch for added files, as Supervisor-taken locks should be added
				// then removed within updateLock.takeLock
				const addedFiles: string[] = [];
				const watcher = watch(lockdir).on('add', (p) => addedFiles.push(p));

				// updateLock.takeLock should error
				await expect(updateLock.takeLock(1, svcs, false)).to.be.rejectedWith(
					UpdatesLockedError,
				);

				// Service without user lock should have been locked by Supervisor..
				expect(addedFiles).to.deep.include.members([
					`${lockdir}/1/${svcs[0]}/updates.lock`,
					`${lockdir}/1/${svcs[0]}/resin-updates.lock`,
				]);

				// ..but upon error, Supervisor-taken locks should have been cleaned up
				expect(
					await lockfile.getLocksTaken(lockdir),
				).to.not.deep.include.members([
					`${lockdir}/1/${svcs[0]}/updates.lock`,
					`${lockdir}/1/${svcs[0]}/resin-updates.lock`,
				]);

				// User lock should be left behind
				expect(await lockfile.getLocksTaken(lockdir)).to.deep.include.members([
					`${lockdir}/1/${svcs[1]}/updates.lock`,
				]);

				// Clean up watcher
				await watcher.close();
			});
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
					await lockfile.lock(lockPath, updateLock.LOCKFILE_UID);
				}
				// Sanity check that locks are taken & tracked by Supervisor
				expect(await updateLock.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				// Release locks for appId 1
				await updateLock.releaseLock(1);
				// Locks should have been released
				expect(await updateLock.getLocksTaken()).to.have.length(0);
				// Double check that the lockfiles are removed
				expect(await fs.readdir(`${lockdir}/1/server`)).to.have.length(0);
				expect(await fs.readdir(`${lockdir}/1/client`)).to.have.length(0);
			});

			it('does not error if there are no locks to release', async () => {
				expect(await updateLock.getLocksTaken()).to.have.length(0);
				// Should not error
				await updateLock.releaseLock(1);
				expect(await updateLock.getLocksTaken()).to.have.length(0);
			});

			it('ignores locks outside of appId scope', async () => {
				const lockPath = `${lockdir}/2/main/updates.lock`;
				// Lock services outside of appId scope
				await lockfile.lock(lockPath, updateLock.LOCKFILE_UID);
				// Sanity check that locks are taken & tracked by Supervisor
				expect(await updateLock.getLocksTaken()).to.deep.include.members([
					lockPath,
				]);
				// Release locks for appId 1
				await updateLock.releaseLock(1);
				// Locks for appId 2 should not have been released
				expect(await updateLock.getLocksTaken()).to.deep.include.members([
					lockPath,
				]);
				// Double check that the lockfile is still there
				expect(await fs.readdir(`${lockdir}/2/main`)).to.have.length(1);
				// Clean up the lockfile
				await lockfile.unlock(lockPath);
			});

			it('waits to release locks until resource write lock is taken', async () => {
				// Lock services for appId 1
				for (const lockPath of serviceLockPaths[1]) {
					await lockfile.lock(lockPath, updateLock.LOCKFILE_UID);
				}
				// Sanity check that locks are taken & tracked by Supervisor
				expect(await updateLock.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				// Take the write lock for appId 1
				const release = await takeGlobalLockRW(1);
				// Queue releaseLock, won't resolve until the write lock is released
				const releaseLockPromise = updateLock.releaseLock(1);
				// Locks should have not been released even after waiting
				await setTimeout(500);
				expect(await updateLock.getLocksTaken()).to.deep.include.members(
					serviceLockPaths[1],
				);
				// Release the write lock
				release();
				// Release locks for appId 1 should resolve
				await releaseLockPromise;
				// Locks should have been released
				expect(await updateLock.getLocksTaken()).to.have.length(0);
			});
		});
	});
});
