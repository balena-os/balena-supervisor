import { expect } from 'chai';
import { promises as fs, mkdirSync } from 'fs';
import { testfs, TestFs } from 'mocha-pod';
import * as os from 'os';
import * as path from 'path';
import { stub } from 'sinon';
import * as lockfile from '~/lib/lockfile';
import * as fsUtils from '~/lib/fs-utils';

const NOBODY_UID = 65534;

describe('lib/lockfile', () => {
	const lockdir = '/tmp/lockdir';

	let testFs: TestFs.Enabled;

	beforeEach(async () => {
		testFs = await testfs(
			{
				[lockdir]: {
					'other.lock': testfs.file({ uid: NOBODY_UID }),
				},
			},
			{ cleanup: [path.join(lockdir, '**.lock')] },
		).enable();
	});

	afterEach(async () => {
		await testFs.restore();
	});

	it('should create a lockfile as the current user by default', async () => {
		const lock = path.join(lockdir, 'updates.lock');

		// Take the lock passing a uid
		await expect(lockfile.lock(lock)).to.not.be.rejected;

		// The file should exist
		await expect(fs.access(lock)).to.not.be.rejected;

		// Verify lockfile UID
		expect((await fs.stat(lock)).uid).to.equal(os.userInfo().uid);
	});

	it('should create a lockfile as the `nobody` user at target path', async () => {
		const lock = path.join(lockdir, 'updates.lock');

		// Take the lock passing a uid
		await expect(lockfile.lock(lock, NOBODY_UID)).to.not.be.rejected;

		// The file should exist
		await expect(fs.access(lock)).to.not.be.rejected;

		// Verify lockfile UID
		expect((await fs.stat(lock)).uid).to.equal(NOBODY_UID);
	});

	it('should not be able to take the lock if it already exists', async () => {
		const lock = path.join(lockdir, 'updates.lock');

		// Take the lock passing a uid
		await expect(lockfile.lock(lock, NOBODY_UID)).to.not.be.rejected;

		// The file should exist
		await expect(fs.access(lock)).to.not.be.rejected;

		// Trying to take the lock again should fail
		await expect(lockfile.lock(lock, NOBODY_UID)).to.be.rejected;
	});

	it('should create a lockfile with the provided `uid` if specified', async () => {
		const lock = path.join(lockdir, 'updates.lock');

		// Take the lock passing a uid
		await expect(lockfile.lock(lock, 2)).to.not.be.rejected;

		// The file should exist
		await expect(fs.access(lock)).to.not.be.rejected;

		// Verify lockfile UID
		expect((await fs.stat(lock)).uid).to.equal(2);
	});

	it('should not create a lockfile if `lock` throws', async () => {
		// Stub the call to exec.
		// WARNING: This is relying on internal knowledge of the function
		// which is generally not a good testing practice, but I'm not sure
		// how to do it otherwise
		const execStub = stub(fsUtils, 'exec').throws(
			new Error('Something bad happened'),
		);

		const lock = path.join(lockdir, 'updates.lock');

		// Take the lock passing a uid
		await expect(lockfile.lock(lock, NOBODY_UID)).to.be.rejected;

		// The file should not have been created
		await expect(fs.access(lock)).to.be.rejected;

		// Restore the stub
		execStub.restore();
	});

	it('should asynchronously unlock a lockfile', async () => {
		const lock = path.join(lockdir, 'updates.lock');

		// Take the lock passing a uid
		await expect(lockfile.lock(lock)).to.not.be.rejected;

		// The file should exist
		await expect(fs.access(lock)).to.not.be.rejected;

		// Unlock should never throw
		await expect(lockfile.unlock(lock)).to.not.be.rejected;

		// The file should no longer exist
		await expect(fs.access(lock)).to.be.rejected;
	});

	it('should asynchronously unlock a lock directory', async () => {
		const lock = path.join(lockdir, 'updates.lock');

		// Crete a lock directory
		await fs.mkdir(lock, { recursive: true });

		// The directory should exist
		await expect(fs.access(lock)).to.not.be.rejected;

		// Unlock should never throw
		await expect(lockfile.unlock(lock)).to.not.be.rejected;

		// The file should no longer exist
		await expect(fs.access(lock)).to.be.rejected;
	});

	it('should not error on async unlock if lockfile does not exist', async () => {
		const lock = path.join(lockdir, 'updates.lock');

		// The file should not exist before
		await expect(fs.access(lock)).to.be.rejected;

		// Unlock should never throw
		await expect(lockfile.unlock(lock)).to.not.be.rejected;

		// The file should still not exist
		await expect(fs.access(lock)).to.be.rejected;
	});

	it('should synchronously unlock a lockfile', () => {
		const lock = path.join(lockdir, 'other.lock');

		lockfile.unlockSync(lock);

		// Verify lockfile does not exist
		return expect(fs.access(lock)).to.be.rejected;
	});

	it('should synchronously unlock a lockfile dir', () => {
		const lock = path.join(lockdir, 'update.lock');

		mkdirSync(lock, { recursive: true });

		lockfile.unlockSync(lock);

		// Verify lockfile does not exist
		return expect(fs.access(lock)).to.be.rejected;
	});

	it('should try to clean up existing locks on process exit', async () => {
		// Create lockfiles
		const lockOne = path.join(lockdir, 'updates.lock');
		const lockTwo = path.join(lockdir, 'two.lock');
		await expect(lockfile.lock(lockOne)).to.not.be.rejected;
		await expect(lockfile.lock(lockTwo, NOBODY_UID)).to.not.be.rejected;

		// @ts-ignore
		process.emit('exit');

		// Verify lockfile removal regardless of appId / appUuid
		await expect(fs.access(lockOne)).to.be.rejected;
		await expect(fs.access(lockTwo)).to.be.rejected;
	});

	it('allows to list locks taken according to a filter function', async () => {
		// Create multiple lockfiles
		const lockOne = path.join(lockdir, 'updates.lock');
		const lockTwo = path.join(lockdir, 'two.lock');
		await expect(lockfile.lock(lockOne)).to.not.be.rejected;
		await expect(lockfile.lock(lockTwo, NOBODY_UID)).to.not.be.rejected;

		expect(
			lockfile.getLocksTaken((filepath) => filepath.includes('lockdir')),
		).to.have.members([lockOne, lockTwo]);
		expect(
			lockfile.getLocksTaken((filepath) => filepath.includes('two')),
		).to.have.members([lockTwo]);
		expect(lockfile.getLocksTaken()).to.have.members([lockOne, lockTwo]);
	});
});
