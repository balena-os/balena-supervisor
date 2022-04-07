import { expect } from 'chai';
import { dirname, basename } from 'path';
import { stub, SinonStub } from 'sinon';
import { promises as fs } from 'fs';
import mock = require('mock-fs');

import * as lockfile from '../../../src/lib/lockfile';
import * as fsUtils from '../../../src/lib/fs-utils';

describe('lib/lockfile', () => {
	const lockPath = `${lockfile.BASE_LOCK_DIR}/1234567/one/updates.lock`;
	const lockPath2 = `${lockfile.BASE_LOCK_DIR}/7654321/two/updates.lock`;

	const mockDir = (opts: { createLock: boolean } = { createLock: false }) => {
		mock({
			[lockfile.BASE_LOCK_DIR]: {
				'1234567': {
					one: opts.createLock
						? { 'updates.lock': mock.file({ uid: lockfile.LOCKFILE_UID }) }
						: {},
				},
				'7654321': {
					two: opts.createLock
						? { 'updates.lock': mock.file({ uid: lockfile.LOCKFILE_UID }) }
						: {},
				},
			},
		});
	};

	const checkLockDirFiles = async (
		path: string,
		opts: { shouldExist: boolean } = { shouldExist: true },
	) => {
		const files = await fs.readdir(dirname(path));
		if (opts.shouldExist) {
			expect(files).to.include(basename(path));
		} else {
			expect(files).to.have.length(0);
		}
	};

	let execStub: SinonStub;

	beforeEach(() => {
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

		mock({ [lockfile.BASE_LOCK_DIR]: {} });
	});

	afterEach(async () => {
		execStub.restore();

		// Even though mock-fs is restored, this is needed to delete any in-memory storage of locks
		for (const lock of lockfile.getLocksTaken()) {
			await lockfile.unlock(lock);
		}

		mock.restore();
	});

	it('should create a lockfile as the `nobody` user at target path', async () => {
		mockDir();

		await lockfile.lock(lockPath);

		// Verify lockfile exists
		await checkLockDirFiles(lockPath, { shouldExist: true });

		// Verify lockfile UID
		expect((await fs.stat(lockPath)).uid).to.equal(lockfile.LOCKFILE_UID);
	});

	it('should create a lockfile with the provided `uid` if specified', async () => {
		mockDir();

		await lockfile.lock(lockPath, 2);

		// Verify lockfile exists
		await checkLockDirFiles(lockPath, { shouldExist: true });

		// Verify lockfile UID
		expect((await fs.stat(lockPath)).uid).to.equal(2);
	});

	it('should not create a lockfile if `lock` throws', async () => {
		mockDir();

		// Override default exec stub declaration, as it normally emulates a lockfile call with
		// no errors, but we want it to throw an error just for this unit test
		execStub.restore();

		const childProcessError = new lockfile.LockfileExistsError(
			'/tmp/test/path',
		);
		execStub = stub(fsUtils, 'exec').throws(childProcessError);

		try {
			await lockfile.lock(lockPath);
			expect.fail('lockfile.lock should throw an error');
		} catch (err) {
			expect(err).to.exist;
		}

		// Verify lockfile does not exist
		await checkLockDirFiles(lockPath, { shouldExist: false });
	});

	it('should asynchronously unlock a lockfile', async () => {
		mockDir({ createLock: true });

		// Verify lockfile exists
		await checkLockDirFiles(lockPath, { shouldExist: true });

		await lockfile.unlock(lockPath);

		// Verify lockfile removal
		await checkLockDirFiles(lockPath, { shouldExist: false });
	});

	it('should not error on async unlock if lockfile does not exist', async () => {
		mockDir({ createLock: false });

		// Verify lockfile does not exist
		await checkLockDirFiles(lockPath, { shouldExist: false });

		try {
			await lockfile.unlock(lockPath);
		} catch (err) {
			expect.fail((err as Error)?.message ?? err);
		}
	});

	it('should synchronously unlock a lockfile', () => {
		mockDir({ createLock: true });

		lockfile.unlockSync(lockPath);

		// Verify lockfile does not exist
		return checkLockDirFiles(lockPath, { shouldExist: false }).catch((err) => {
			expect.fail((err as Error)?.message ?? err);
		});
	});

	it('should try to clean up existing locks on process exit', async () => {
		mockDir({ createLock: false });

		// Create lockfiles for multiple appId / uuids
		await lockfile.lock(lockPath);
		await lockfile.lock(lockPath2);

		// @ts-ignore
		process.emit('exit');

		// Verify lockfile removal regardless of appId / appUuid
		await checkLockDirFiles(lockPath, { shouldExist: false });
		await checkLockDirFiles(lockPath2, { shouldExist: false });
	});

	it('should list locks taken according to a filter function', async () => {
		mockDir({ createLock: false });

		// Create lockfiles for multiple appId / uuids
		await lockfile.lock(lockPath);
		await lockfile.lock(lockPath2);

		expect(
			lockfile.getLocksTaken((path) => path.includes('1234567')),
		).to.have.members([lockPath]);
		expect(
			lockfile.getLocksTaken((path) => path.includes('7654321')),
		).to.have.members([lockPath2]);
		expect(lockfile.getLocksTaken()).to.have.members([lockPath, lockPath2]);
	});
});
