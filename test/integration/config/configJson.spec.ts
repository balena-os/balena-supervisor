import { expect } from 'chai';
import { testfs } from 'mocha-pod';
import { promises as fs } from 'fs';

import ConfigJsonConfigBackend from '~/src/config/configJson';
import { schema } from '~/src/config/schema';

describe('ConfigJsonConfigBackend', () => {
	const CONFIG_PATH = '/mnt/boot/config.json';
	let configJsonConfigBackend: ConfigJsonConfigBackend;

	beforeEach(() => {
		configJsonConfigBackend = new ConfigJsonConfigBackend(schema);
	});

	it('should get value for config.json key', async () => {
		await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		await testfs.restore();
	});

	it('should set value for config.json key', async () => {
		await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		await configJsonConfigBackend.set({
			apiEndpoint: 'bar',
		});

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('bar');

		await testfs.restore();
	});

	// The following test cases may be unnecessary as they test cases where another party
	// writes to config.json directly (instead of through setting config vars on the API).
	it('should get cached value even if actual value has changed', async () => {
		await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		// The cached value should be returned
		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		// Change the value in the file
		await fs.writeFile(
			CONFIG_PATH,
			JSON.stringify({
				apiEndpoint: 'bar',
			}),
		);

		// Unintended behavior: the cached value should not be overwritten
		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		await testfs.restore();
	});

	it('should set value and refresh cache to equal new value', async () => {
		await testfs({
			[CONFIG_PATH]: JSON.stringify({
				apiEndpoint: 'foo',
			}),
			'/mnt/root/etc/os-release': testfs.from('test/data/etc/os-release'),
		}).enable();

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		await fs.writeFile(
			CONFIG_PATH,
			JSON.stringify({
				apiEndpoint: 'bar',
			}),
		);

		// Unintended behavior: cached value should not have been updated
		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('foo');

		await configJsonConfigBackend.set({
			apiEndpoint: 'baz',
		});

		expect(await configJsonConfigBackend.get('apiEndpoint')).to.equal('baz');

		await testfs.restore();
	});
});
