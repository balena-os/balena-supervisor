import { expect } from 'chai';
import { promises as fs } from 'fs';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';
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

	it('should get locks taken with default args', async () => {
		// Set up lock dirs
		await fs.mkdir(`${lockdir}/1/main`, { recursive: true });
		await fs.mkdir(`${lockdir}/2/aux`, { recursive: true });

		// Take some locks
		const locks = [
			`${lockdir}/updates.lock`,
			`${lockdir}/two.lock`,
			`${lockdir}/1/main/updates.lock`,
			`${lockdir}/1/main/resin-updates.lock`,
			`${lockdir}/2/aux/updates.lock`,
			`${lockdir}/2/aux/resin-updates.lock`,
		];
		await Promise.all(locks.map((lock) => lockfile.lock(lock)));

		// Assert all locks are listed as taken
		expect(await lockfile.getLocksTaken(lockdir)).to.have.members(
			locks.concat([`${lockdir}/other.lock`]),
		);

		// Clean up locks
		await fs.rm(`${lockdir}`, { recursive: true });
	});

	it('should get locks taken with a custom filter', async () => {
		// Set up lock dirs
		await fs.mkdir(`${lockdir}/1`, { recursive: true });
		await fs.mkdir(`${lockdir}/services/main`, { recursive: true });
		await fs.mkdir(`${lockdir}/services/aux`, { recursive: true });

		// Take some locks...
		// - with a specific UID
		await lockfile.lock(`${lockdir}/updates.lock`, NOBODY_UID);
		// - as a directory
		await fs.mkdir(`${lockdir}/1/updates.lock`);
		// - as a directory with a specific UID
		await fs.mkdir(`${lockdir}/1/resin-updates.lock`);
		await fs.chown(`${lockdir}/1/resin-updates.lock`, NOBODY_UID, NOBODY_UID);
		// - under a different root dir from default
		await lockfile.lock(`${lockdir}/services/main/updates.lock`);
		await lockfile.lock(`${lockdir}/services/aux/resin-updates.lock`);

		// Assert appropriate locks are listed as taken...
		// - with a specific UID
		expect(
			await lockfile.getLocksTaken(
				lockdir,
				(p, stats) => p.endsWith('.lock') && stats.uid === NOBODY_UID,
			),
		).to.have.members([
			`${lockdir}/updates.lock`,
			`${lockdir}/1/resin-updates.lock`,
			`${lockdir}/other.lock`,
		]);
		// - as a directory
		expect(
			await lockfile.getLocksTaken(
				lockdir,
				(p, stats) => p.endsWith('.lock') && stats.isDirectory(),
			),
		).to.have.members([
			`${lockdir}/1/updates.lock`,
			`${lockdir}/1/resin-updates.lock`,
		]);
		// - under a different root dir from default
		expect(
			await lockfile.getLocksTaken(`${lockdir}/services`, (p) =>
				p.endsWith('.lock'),
			),
		).to.have.members([
			`${lockdir}/services/main/updates.lock`,
			`${lockdir}/services/aux/resin-updates.lock`,
		]);

		// Clean up locks
		await fs.rm(`${lockdir}`, { recursive: true });
	});
});
