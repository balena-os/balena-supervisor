import { expect } from 'chai';
import * as path from 'path';
import { promises as fs } from 'fs';
import { spy, SinonSpy } from 'sinon';
import mock = require('mock-fs');

import * as fsUtils from '../../../src/lib/fs-utils';
import { rootMountPoint } from '../../../src/lib/constants';

describe('lib/fs-utils', () => {
	const testFileName1 = 'file.1';
	const testFileName2 = 'file.2';
	const testFile1 = path.join(rootMountPoint, testFileName1);
	const testFile2 = path.join(rootMountPoint, testFileName2);

	const mockFs = () => {
		mock({
			[testFile1]: mock.file({
				content: 'foo',
				mtime: new Date('2022-01-04T00:00:00'),
			}),
			[testFile2]: mock.file({
				content: 'bar',
				mtime: new Date('2022-01-04T00:00:00'),
			}),
		});
	};

	const unmockFs = () => {
		mock.restore();
	};

	describe('writeAndSyncFile', () => {
		before(mockFs);
		after(unmockFs);

		it('should write and sync string data', async () => {
			await fsUtils.writeAndSyncFile(testFile1, 'foo bar');
			expect(await fs.readFile(testFile1, 'utf-8')).to.equal('foo bar');
		});

		it('should write and sync buffers', async () => {
			await fsUtils.writeAndSyncFile(testFile1, Buffer.from('bar foo'));
			expect(await fs.readFile(testFile1, 'utf-8')).to.equal('bar foo');
		});
	});

	describe('writeFileAtomic', () => {
		before(() => {
			spy(fs, 'rename');
			mockFs();
		});

		after(() => {
			(fs.rename as SinonSpy).restore();
			unmockFs();
		});

		it('should write string data atomically', async () => {
			await fsUtils.writeFileAtomic(testFile1, 'foo baz');
			expect(await fs.readFile(testFile1, 'utf-8')).to.equal('foo baz');
			expect(fs.rename).to.have.been.calledWith(`${testFile1}.new`, testFile1);
		});

		it('should write buffer data atomically', async () => {
			await fsUtils.writeFileAtomic(testFile1, 'baz foo');
			expect(await fs.readFile(testFile1, 'utf-8')).to.equal('baz foo');
			expect(fs.rename).to.have.been.calledWith(`${testFile1}.new`, testFile1);
		});
	});

	describe('safeRename', () => {
		beforeEach(mockFs);
		afterEach(unmockFs);

		it('should rename a file', async () => {
			await fsUtils.safeRename(testFile1, testFile1 + 'rename');
			const dirContents = await fs.readdir(rootMountPoint);
			expect(dirContents).to.have.length(2);
			expect(dirContents).to.not.include(testFileName1);
			expect(dirContents).to.include(testFileName1 + 'rename');
		});

		it('should replace an existing file', async () => {
			await fsUtils.safeRename(testFile1, testFile2);
			const dirContents = await fs.readdir(rootMountPoint);
			expect(dirContents).to.have.length(1);
			expect(dirContents).to.include(testFileName2);
			expect(dirContents).to.not.include(testFileName1);
		});
	});

	/**
	 * TODO: Un-skip this test after all fs tests that write to a test file system use
	 * mock-fs instead. Hypothesis: exists isn't handling the relative directory it's
	 * being passed well. When all unit tests use mock-fs, we can set process.env.ROOT_MOUNTPOINT
	 * to `/mnt/root` so we can have an absolute path in all these tests.
	 */
	describe.skip('exists', () => {
		before(mockFs);
		after(unmockFs);

		it('should return whether a file exists', async () => {
			expect(await fsUtils.exists(testFile1)).to.be.true;
			await fs.unlink(testFile1).catch(() => {
				/* noop */
			});
			expect(await fsUtils.exists(testFile1)).to.be.false;
		});
	});

	describe('pathExistsOnHost', () => {
		before(mockFs);
		after(unmockFs);

		it('should return whether a file exists in host OS fs', async () => {
			expect(await fsUtils.pathExistsOnHost(testFileName1)).to.be.true;
			await fs.unlink(testFile1);
			expect(await fsUtils.pathExistsOnHost(testFileName1)).to.be.false;
		});
	});

	describe('mkdirp', () => {
		before(mockFs);
		after(unmockFs);

		it('should recursively create directories', async () => {
			await fsUtils.mkdirp(
				path.join(rootMountPoint, 'test1', 'test2', 'test3'),
			);
			expect(() =>
				fs.readdir(path.join(rootMountPoint, 'test1', 'test2', 'test3')),
			).to.not.throw();
		});
	});

	describe('unlinkAll', () => {
		beforeEach(mockFs);
		afterEach(unmockFs);

		it('should unlink a single file', async () => {
			await fsUtils.unlinkAll(testFile1);
			expect(await fs.readdir(rootMountPoint)).to.not.include(testFileName1);
		});

		it('should unlink multiple files', async () => {
			await fsUtils.unlinkAll(testFile1, testFile2);
			expect(await fs.readdir(rootMountPoint)).to.have.length(0);
		});
	});

	describe('getPathOnHost', () => {
		before(mockFs);
		after(unmockFs);

		it("should return the paths of one or more files as they exist on host OS's root", async () => {
			expect(fsUtils.getPathOnHost(testFileName1)).to.deep.equal(testFile1);
			expect(
				fsUtils.getPathOnHost(testFileName1, testFileName2),
			).to.deep.equal([testFile1, testFile2]);
		});
	});

	describe('touch', () => {
		beforeEach(mockFs);
		afterEach(unmockFs);

		it('creates the file if it does not exist', async () => {
			await fsUtils.touch('somefile');
			expect(await fsUtils.exists('somefile')).to.be.true;
		});

		it('updates the file mtime if file already exists', async () => {
			const statsBefore = await fs.stat(testFile1);
			await fsUtils.touch(testFile1);
			const statsAfter = await fs.stat(testFile1);

			// Mtime should be different
			expect(statsAfter.mtime.getTime()).to.not.equal(
				statsBefore.mtime.getTime(),
			);
		});

		it('allows setting a custom time for existing files', async () => {
			const customTime = new Date('1981-11-24T12:00:00');
			await fsUtils.touch(testFile1, customTime);
			const statsAfter = await fs.stat(testFile1);

			expect(statsAfter.mtime.getTime()).to.be.equal(customTime.getTime());
		});

		it('allows setting a custom time for newly created files', async () => {
			const customTime = new Date('1981-11-24T12:00:00');
			await fsUtils.touch('somefile', customTime);
			const statsAfter = await fs.stat('somefile');

			expect(statsAfter.mtime.getTime()).to.be.equal(customTime.getTime());
		});
	});
});
