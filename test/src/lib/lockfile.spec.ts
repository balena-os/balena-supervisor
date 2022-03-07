import { expect } from 'chai';
import { dirname, basename } from 'path';
import { stub, SinonStub } from 'sinon';
import { promises as fs } from 'fs';
import mock = require('mock-fs');

import * as lockfile from '../../../src/lib/lockfile';
import * as fsUtils from '../../../src/lib/fs-utils';
import { ChildProcessError } from '../../../src/lib/errors';

describe('lib/lockfile', () => {
	const lockPath = `${lockfile.BASE_LOCK_DIR}/1234567/updates.lock`;
	// mock-fs expects an octal file mode, however, Node's fs.stat.mode returns a bit field:
	//   - 16877 (Node) == octal 0755 (drwxr-xr-x)
	//   - 17407 (Node) == octal 1777 (drwxrwxrwt)
	const DEFAULT_PERMISSIONS = {
		unix: 0o755,
		node: 16877,
	};
	const STICKY_WRITE_PERMISSIONS = {
		unix: 0o1777,
		node: 17407,
	};

	const mockDir = (
		mode: number = DEFAULT_PERMISSIONS.unix,
		opts: { createLock: boolean } = { createLock: false },
	) => {
		const items: any = {};
		if (opts.createLock) {
			items[basename(lockPath)] = mock.file({ uid: lockfile.LOCKFILE_UID });
		}

		mock({
			[dirname(lockPath)]: mock.directory({
				mode,
				items,
			}),
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
	});

	afterEach(() => {
		execStub.restore();
		mock.restore();
	});

	it('should create a lockfile as the `nobody` user at target path', async () => {
		// Mock directory with default permissions
		mockDir();

		await lockfile.lock(lockPath);

		// Verify lockfile exists
		await checkLockDirFiles(lockPath, { shouldExist: true });

		// Verify lockfile UID
		expect((await fs.stat(lockPath)).uid).to.equal(lockfile.LOCKFILE_UID);
	});

	it('should create a lockfile with the provided `uid` if specified', async () => {
		// Mock directory with default permissions
		mockDir();

		await lockfile.lock(lockPath, 2);

		// Verify lockfile exists
		await checkLockDirFiles(lockPath, { shouldExist: true });

		// Verify lockfile UID
		expect((await fs.stat(lockPath)).uid).to.equal(2);
	});

	it('should not create a lockfile if `lock` throws', async () => {
		// Mock directory with default permissions
		mockDir();

		// Override default exec stub declaration, as it normally emulates a lockfile call with
		// no errors, but we want it to throw an error just for this unit test
		execStub.restore();

		const childProcessError = new Error() as ChildProcessError;
		childProcessError.code = 73;
		childProcessError.stderr = 'lockfile: Test error';

		execStub = stub(fsUtils, 'exec').throws(childProcessError);

		try {
			await lockfile.lock(lockPath);
			expect.fail('lockfile.lock should have thrown an error');
		} catch (err) {
			expect(err).to.exist;
		}

		// Verify lockfile does not exist
		await checkLockDirFiles(lockPath, { shouldExist: false });
	});

	it('should asynchronously unlock a lockfile', async () => {
		// Mock directory with sticky + write permissions and existing lockfile
		mockDir(STICKY_WRITE_PERMISSIONS.unix, { createLock: true });

		// Verify lockfile exists
		await checkLockDirFiles(lockPath, { shouldExist: true });

		await lockfile.unlock(lockPath);

		// Verify lockfile removal
		await checkLockDirFiles(lockPath, { shouldExist: false });
	});

	it('should not error on async unlock if lockfile does not exist', async () => {
		// Mock directory with sticky + write permissions
		mockDir(STICKY_WRITE_PERMISSIONS.unix, { createLock: false });

		// Verify lockfile does not exist
		await checkLockDirFiles(lockPath, { shouldExist: false });

		try {
			await lockfile.unlock(lockPath);
		} catch (err) {
			expect.fail((err as Error)?.message ?? err);
		}
	});

	it('should synchronously unlock a lockfile', () => {
		// Mock directory with sticky + write permissions
		mockDir(STICKY_WRITE_PERMISSIONS.unix, { createLock: true });

		lockfile.unlockSync(lockPath);

		// Verify lockfile does not exist
		return checkLockDirFiles(lockPath, { shouldExist: false }).catch((err) => {
			expect.fail((err as Error)?.message ?? err);
		});
	});
});
