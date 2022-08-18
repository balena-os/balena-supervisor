import { expect } from 'chai';

import * as osRelease from '~/lib/os-release';

const OS_RELEASE_PATH = 'test/data/etc/os-release-tx2';

describe('OS Release Information', () => {
	it('gets pretty name', async () => {
		// Try to get PRETTY_NAME
		await expect(osRelease.getOSVersion(OS_RELEASE_PATH)).to.eventually.equal(
			'balenaOS 2.45.1+rev3',
		);
	});

	it('gets variant', async () => {
		// Try to get VARIANT_ID
		await expect(osRelease.getOSVariant(OS_RELEASE_PATH)).to.eventually.equal(
			'prod',
		);
	});

	it('gets version', async () => {
		// Try to get VERSION
		await expect(osRelease.getOSSemver(OS_RELEASE_PATH)).to.eventually.equal(
			'2.45.1+rev3',
		);
	});

	it('gets meta release version', async () => {
		// Try to get META_BALENA_VERSIONS
		await expect(
			osRelease.getMetaOSRelease(OS_RELEASE_PATH),
		).to.eventually.equal('2.45.1');
	});
});
