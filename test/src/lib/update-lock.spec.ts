import { expect } from 'chai';
import { SinonSpy, SinonStub, spy, stub } from 'sinon';
import * as path from 'path';
import { promises as fs } from 'fs';
import mockFs = require('mock-fs');

import * as updateLock from '../../../src/lib/update-lock';
import * as constants from '../../../src/lib/constants';
import { UpdatesLockedError } from '../../../src/lib/errors';
import * as config from '../../../src/config';
import * as lockfile from '../../../src/lib/lockfile';
import * as fsUtils from '../../../src/lib/fs-utils';

describe('lib/update-lock', () => {
	const appId = 1234567;
	const serviceName = 'test';

	const mockLockDir = ({
		createLockfile = true,
	}: {
		createLockfile?: boolean;
	}) => {
		const lockDirFiles: any = {};
		if (createLockfile) {
			lockDirFiles['updates.lock'] = mockFs.file({
				uid: updateLock.LOCKFILE_UID,
			});
			lockDirFiles['resin-updates.lock'] = mockFs.file({
				uid: updateLock.LOCKFILE_UID,
			});
		}
		mockFs({
			[path.join(
				constants.rootMountPoint,
				updateLock.lockPath(appId),
				serviceName,
			)]: lockDirFiles,
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

	describe('lockPath', () => {
		it('should return path prefix of service lockfiles on host', () => {
			expect(updateLock.lockPath(appId)).to.equal(
				`/tmp/balena-supervisor/services/${appId}`,
			);
			expect(updateLock.lockPath(appId, serviceName)).to.equal(
				`/tmp/balena-supervisor/services/${appId}/${serviceName}`,
			);
		});
	});

	describe('abortIfHUPInProgress', () => {
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
		const getLockParentDir = (): string =>
			`${constants.rootMountPoint}${updateLock.lockPath(appId, serviceName)}`;

		const expectLocks = async (exists: boolean = true) => {
			expect(await fs.readdir(getLockParentDir())).to.deep.equal(
				exists ? ['resin-updates.lock', 'updates.lock'] : [],
			);
		};

		let unlockSpy: SinonSpy;
		let lockSpy: SinonSpy;
		let execStub: SinonStub;

		let configGetStub: SinonStub;

		beforeEach(() => {
			unlockSpy = spy(lockfile, 'unlock');
			lockSpy = spy(lockfile, 'lock');
			// lockfile.lock calls exec to interface with the lockfile binary,
			// so mock it here as we don't have access to the binary in the test env
			// @ts-ignore
			execStub = stub(fsUtils, 'exec').callsFake(async (command, opts) => {
				// Sanity check for the command call
				expect(command.trim().startsWith('lockfile')).to.be.true;

				// Remove any `lockfile` command options to leave just the command and the target filepath
				const [, targetPath] = command
					.replace(/-v|-nnn|-r\s+\d+|-l\s+\d+|-s\s+\d+|-!|-ml|-mu/g, '')
					.split(/\s+/);

				// Emulate the lockfile binary exec call
				await fsUtils.touch(targetPath);
				await fs.chown(targetPath, opts!.uid!, 0);
			});

			// config.get is called in updateLock.lock to get `lockOverride` value,
			// so mock it here to definitively avoid any side effects
			configGetStub = stub(config, 'get').resolves(false);
		});

		afterEach(async () => {
			unlockSpy.restore();
			lockSpy.restore();
			execStub.restore();

			configGetStub.restore();

			// Even though mock-fs is restored, this is needed to delete any in-memory storage of locks
			for (const lock of lockfile.getLocksTaken()) {
				await lockfile.unlock(lock);
			}

			mockFs.restore();
		});

		it('should take the lock, run the function, then dispose of locks', async () => {
			// Set up fake filesystem for lockfiles
			mockLockDir({ createLockfile: false });

			await expect(
				updateLock.lock(appId, { force: false }, async () => {
					// At this point the locks should be taken and not removed
					// until this function has been resolved
					await expectLocks(true);
					return Promise.resolve();
				}),
			).to.eventually.be.fulfilled;

			// Both `updates.lock` and `resin-updates.lock` should have been taken
			expect(lockSpy.args).to.have.length(2);

			// Everything that was locked should have been unlocked
			expect(lockSpy.args.map(([lock]) => [lock])).to.deep.equal(
				unlockSpy.args,
			);
		});

		it('should throw UpdatesLockedError if lockfile exists', async () => {
			// Set up fake filesystem for lockfiles
			mockLockDir({ createLockfile: true });

			const lockPath = `${getLockParentDir()}/updates.lock`;

			execStub.throws(new lockfile.LockfileExistsError(lockPath));

			try {
				await updateLock.lock(appId, { force: false }, async () => {
					await expectLocks(false);
					return Promise.resolve();
				});
				expect.fail('updateLock.lock should throw an UpdatesLockedError');
			} catch (err) {
				expect(err).to.be.instanceOf(UpdatesLockedError);
			}

			// Should only have attempted to take `updates.lock`
			expect(lockSpy.args.flat()).to.deep.equal([
				lockPath,
				updateLock.LOCKFILE_UID,
			]);

			// Since the lock-taking failed, there should be no locks to dispose of
			expect(lockfile.getLocksTaken()).to.have.length(0);

			// Since nothing was locked, nothing should be unlocked
			expect(unlockSpy.args).to.have.length(0);
		});

		it('should dispose of taken locks on any other errors', async () => {
			// Set up fake filesystem for lockfiles
			mockLockDir({ createLockfile: false });

			try {
				await updateLock.lock(
					appId,
					{ force: false },
					// At this point 2 lockfiles have been written, so this is testing
					// that even if the function rejects, lockfiles will be disposed of
					async () => {
						await expectLocks();
						return Promise.reject(new Error('Test error'));
					},
				);
			} catch {
				/* noop */
				// This just catches the 'Test error' above
			}

			// Both `updates.lock` and `resin-updates.lock` should have been taken
			expect(lockSpy.args).to.have.length(2);

			// Everything that was locked should have been unlocked
			expect(lockSpy.args.map(([lock]) => [lock])).to.deep.equal(
				unlockSpy.args,
			);
		});

		it('locks all applications before resolving input function', async () => {
			const appIds = [111, 222, 333];
			// Set up fake filesystem for lockfiles
			mockFs({
				[path.join(
					constants.rootMountPoint,
					updateLock.lockPath(111),
					serviceName,
				)]: {},
				[path.join(
					constants.rootMountPoint,
					updateLock.lockPath(222),
					serviceName,
				)]: {},
				[path.join(
					constants.rootMountPoint,
					updateLock.lockPath(333),
					serviceName,
				)]: {},
			});

			await expect(
				updateLock.lock(appIds, { force: false }, async () => {
					// At this point the locks should be taken and not removed
					// until this function has been resolved
					// Both `updates.lock` and `resin-updates.lock` should have been taken
					expect(lockSpy.args).to.have.length(6);
					// Make sure that no locks have been removed also
					expect(unlockSpy).to.not.be.called;
					return Promise.resolve();
				}),
			).to.eventually.be.fulfilled;

			// Everything that was locked should have been unlocked after function resolves
			expect(lockSpy.args.map(([lock]) => [lock])).to.deep.equal(
				unlockSpy.args,
			);
		});

		it('resolves input function without locking when appId is null', async () => {
			mockLockDir({ createLockfile: true });

			await expect(
				updateLock.lock(null as any, { force: false }, stub().resolves()),
			).to.be.fulfilled;

			// Since appId is null, updateLock.lock should just run the function, so
			// there should be no interfacing with the lockfile module
			expect(unlockSpy).to.not.have.been.called;
			expect(lockSpy).to.not.have.been.called;
		});

		it('unlocks lockfile to resolve function if force option specified', async () => {
			mockLockDir({ createLockfile: true });

			await expect(updateLock.lock(1234567, { force: true }, stub().resolves()))
				.to.be.fulfilled;

			expect(unlockSpy).to.have.been.called;
			expect(lockSpy).to.have.been.called;
		});

		it('unlocks lockfile to resolve function if lockOverride option specified', async () => {
			configGetStub.resolves(true);
			mockLockDir({ createLockfile: true });

			await expect(
				updateLock.lock(1234567, { force: false }, stub().resolves()),
			).to.be.fulfilled;

			expect(unlockSpy).to.have.been.called;
			expect(lockSpy).to.have.been.called;
		});
	});
});
