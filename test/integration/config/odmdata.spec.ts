import { promises as fs } from 'fs';
import { expect } from 'chai';
import { testfs } from 'mocha-pod';

import * as hostUtils from '~/lib/host-utils';

import log from '~/lib/supervisor-console';
import { Odmdata } from '~/src/config/backends/odmdata';

describe('config/odmdata', () => {
	const backend = new Odmdata();

	it('logs error when unable to open boot config file', async () => {
		await expect(
			fs.access(hostUtils.pathOnRoot('/dev/mmcblk0boot0')),
			'file does not exist before the test',
		).to.be.rejected;

		await expect(backend.getBootConfig()).to.be.rejected;

		expect(log.error).to.have.been.calledWith(
			`File not found at: ${hostUtils.pathOnRoot('/dev/mmcblk0boot0')}`,
		);
	});

	it('logs error for malformed configuration mode', async () => {
		// Logs when configuration mode is unknown
		// @ts-expect-error accessing private value
		expect(() => backend.parseOptions(Buffer.from([0x9, 0x9, 0x9]))).to.throw();
		expect(log.error).to.have.been.calledWith(
			'ODMDATA is set with an unsupported byte: 0x9',
		);

		// @ts-expect-error accessing private value
		expect(() => backend.parseOptions(Buffer.from([0x1, 0x0, 0x0]))).to.throw();
		expect(log.error).to.have.been.calledWith(
			'Unable to parse ODMDATA configuration. Data at offsets do not match.',
		);
	});

	it('should parse configuration options from bootConfigPath', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnRoot('/dev/mmcblk0boot0')]: testfs.from(
				'test/data/boot0.img',
			),
		}).enable();

		// Restore openFile so test actually uses testConfigPath
		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			configuration: '2',
		});

		await tfs.restore();
	});

	it('sets new config values', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnRoot('/dev/mmcblk0boot0')]: testfs.from(
				'test/data/boot0.img',
			),
			[hostUtils.pathOnRoot('/sys/block/mmcblk0boot0/force_ro')]: '0',
		}).enable();

		// Sets a new configuration
		await backend.setBootConfig({
			configuration: '4',
		});
		// Check that new configuration was set correctly
		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			configuration: '4',
		});

		await tfs.restore();
	});
});
