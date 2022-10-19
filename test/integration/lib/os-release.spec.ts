import { expect } from 'chai';
import { testfs, TestFs } from 'mocha-pod';

import * as osRelease from '~/lib/os-release';

describe('lib/os-release', () => {
	let tfs: TestFs.Enabled;
	before(async () => {
		tfs = await testfs({
			'/etc/os-release': testfs.from('test/data/etc/os-release-tx2'),
		}).enable();
	});

	after(async () => {
		await tfs.restore();
	});

	it('gets pretty name', async () => {
		// Try to get PRETTY_NAME
		await expect(osRelease.getOSVersion('/etc/os-release')).to.eventually.equal(
			'balenaOS 2.45.1+rev3',
		);
	});

	it('gets variant', async () => {
		// Try to get VARIANT_ID
		await expect(osRelease.getOSVariant('/etc/os-release')).to.eventually.equal(
			'prod',
		);
	});

	it('gets version', async () => {
		// Try to get VERSION
		await expect(osRelease.getOSSemver('/etc/os-release')).to.eventually.equal(
			'2.45.1+rev3',
		);
	});

	it('gets meta release version', async () => {
		// Try to get META_BALENA_VERSIONS
		await expect(
			osRelease.getMetaOSRelease('/etc/os-release'),
		).to.eventually.equal('2.45.1');
	});
});
