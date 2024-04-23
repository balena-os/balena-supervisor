import { expect } from 'chai';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';
import { watch } from 'chokidar';

import * as fsUtils from '~/lib/fs-utils';

describe('lib/fs-utils', () => {
	const file1 = 'file.1';
	const filePath1 = '/test/file.1';
	const file2 = 'file.2';
	const filePath2 = '/test/file.2';

	describe('writeAndSyncFile', () => {
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs(
				{
					[filePath1]: 'foo',
				},
				{ cleanup: ['/test/*'] },
			).enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('should write and sync string data', async () => {
			await fsUtils.writeAndSyncFile(filePath1, 'foo bar');
			expect(await fs.readFile(filePath1, 'utf-8')).to.equal('foo bar');
		});

		it('should write and sync buffers', async () => {
			await fsUtils.writeAndSyncFile(filePath1, Buffer.from('bar foo'));
			expect(await fs.readFile(filePath1, 'utf-8')).to.equal('bar foo');
		});
	});

	describe('writeFileAtomic', () => {
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs(
				{
					[filePath2]: 'foo',
				},
				{ cleanup: ['/test/*'] },
			).enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('should write string data atomically', async () => {
			// Watch for added files, there should be a [file].new due to atomic rename
			const addedFiles: string[] = [];
			const watcher = watch('/test').on('add', (p) => addedFiles.push(p));

			await fsUtils.writeFileAtomic(filePath2, 'foo baz');
			expect(await fs.readFile(filePath2, 'utf-8')).to.equal('foo baz');

			expect(addedFiles).to.have.deep.include.members([
				filePath2,
				`${filePath2}.new`,
			]);

			// Clean up watcher
			await watcher.close();
		});

		it('should write buffer data atomically', async () => {
			// Watch for added files, there should be a [file].new due to atomic rename
			const addedFiles: string[] = [];
			const watcher = watch('/test').on('add', (p) => addedFiles.push(p));

			await fsUtils.writeFileAtomic(filePath2, Buffer.from('baz foo'));
			expect(await fs.readFile(filePath2, 'utf-8')).to.equal('baz foo');

			expect(addedFiles).to.have.deep.include.members([
				filePath2,
				`${filePath2}.new`,
			]);

			// Clean up watcher
			await watcher.close();
		});
	});

	describe('safeRename', () => {
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs(
				{
					[filePath1]: 'foo',
					[filePath2]: 'bar',
				},
				{ cleanup: ['/test/*'] },
			).enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('should rename a file', async () => {
			await fsUtils.safeRename(filePath1, `${filePath1}.rename`);
			const dirContents = await fs.readdir('/test');
			expect(dirContents).to.have.length(2);
			expect(dirContents).to.deep.include.members([`${file1}.rename`, file2]);
		});

		it('should replace an existing file', async () => {
			await fsUtils.safeRename(filePath1, filePath2);
			const dirContents = await fs.readdir('/test');
			expect(dirContents).to.have.length(1);
			expect(dirContents).to.include(file2);
			expect(dirContents).to.not.include(file1);
		});
	});

	describe('exists', () => {
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs(
				{
					[filePath1]: 'foo',
				},
				{ cleanup: ['/test/*'] },
			).enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('should return whether a file exists', async () => {
			expect(await fsUtils.exists(filePath1)).to.be.true;
			await fs.unlink(filePath1).catch(() => {
				/* noop */
			});
			expect(await fsUtils.exists(filePath1)).to.be.false;
		});
	});

	describe('mkdirp', () => {
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs(
				{
					'/test': {},
				},
				{ cleanup: ['/test/*'] },
			).enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('should recursively create directories', async () => {
			const directory = path.join('/test', 'test1', 'test2', 'test3');
			await fsUtils.mkdirp(directory);
			expect(() => fs.readdir(directory)).to.not.throw();
			// TODO: testfs cleanup doesn't seem to support directories
			await fs.rm('/test/test1', { recursive: true });
		});
	});

	describe('unlinkAll', () => {
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs(
				{
					[filePath1]: 'foo',
					[filePath2]: 'bar',
				},
				{ cleanup: ['/test/*'] },
			).enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('should unlink a single file', async () => {
			await fsUtils.unlinkAll(filePath1);
			expect(await fs.readdir('/test')).to.not.include(file1);
		});

		it('should unlink multiple files', async () => {
			await fsUtils.unlinkAll(filePath1, filePath2);
			expect(await fs.readdir('/test')).to.have.length(0);
		});
	});

	describe('touch', () => {
		let tFs: TestFs.Enabled;
		beforeEach(async () => {
			tFs = await testfs(
				{
					[filePath1]: testfs.file({
						contents: '',
						mtime: new Date('2024-01-01T00:00:00'),
					}),
				},
				{ cleanup: ['/test/*'] },
			).enable();
		});

		afterEach(async () => {
			await tFs.restore();
		});

		it('creates the file if it does not exist', async () => {
			await fsUtils.touch('/test/somefile');
			expect(await fs.readdir('/test')).to.include('somefile');
		});

		it('updates the file mtime if file already exists', async () => {
			const statsBefore = await fs.stat(filePath1);
			await fsUtils.touch(filePath1);
			const statsAfter = await fs.stat(filePath1);

			// Mtime should be different
			expect(statsAfter.mtime.getTime()).to.not.equal(
				statsBefore.mtime.getTime(),
			);
		});

		it('allows setting a custom time for existing files', async () => {
			const customTime = new Date('1981-11-24T12:00:00');
			await fsUtils.touch(filePath1, customTime);
			const statsAfter = await fs.stat(filePath1);

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
