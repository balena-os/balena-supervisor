import _ from 'lodash';
import * as path from 'path';
import { promises as fs } from 'fs';
import { SinonSpy, spy, stub } from 'sinon';
import { expect } from 'chai';
import { testfs, TestFs } from 'mocha-pod';
import * as hostUtils from '~/lib/host-utils';

import constants from '~/lib/constants';
import { fnSchema } from '~/src/config/functions';

describe('config', () => {
	const configJsonPath = path.join(
		constants.rootMountPoint,
		constants.bootMountPoint,
		'config.json',
	);
	const deviceTypeJsonPath = path.join(
		constants.rootMountPoint,
		constants.bootMountPoint,
		'device-type.json',
	);

	const readConfigJson = () =>
		fs.readFile(configJsonPath, 'utf8').then((data) => JSON.parse(data));

	const readDeviceTypeJson = () =>
		fs.readFile(deviceTypeJsonPath, 'utf8').then((data) => JSON.parse(data));

	let testFs: TestFs.Enabled;

	beforeEach(async () => {
		testFs = await testfs({
			[configJsonPath]: testfs.from('test/data/testconfig.json'),
			[deviceTypeJsonPath]: testfs.from('test/data/mnt/boot/device-type.json'),
		}).enable();
	});

	afterEach(async () => {
		await testFs.restore();
		delete require.cache[require.resolve('~/src/config')];
	});

	it('reads and exposes values from config.json', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		const configJson = await readConfigJson();
		const id = await config.get('applicationId');
		return expect(id).to.equal(configJson.applicationId);
	});

	it('allows reading several values in one getMany call', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		const configJson = await readConfigJson();
		return expect(
			await config.getMany(['applicationId', 'apiEndpoint']),
		).to.deep.equal({
			applicationId: configJson.applicationId,
			apiEndpoint: configJson.apiEndpoint,
		});
	});

	it('generates a uuid and stores it in config.json', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		const configJson = await readConfigJson();
		const uuid = await config.get('uuid');
		expect(uuid).to.be.a('string');
		expect(uuid).to.have.lengthOf(32);
		expect(uuid).to.equal(configJson.uuid);
	});

	it('does not allow setting an immutable field', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		return expect(config.set({ deviceType: 'a different device type' })).to.be
			.rejected;
	});

	it('allows setting both config.json and database fields transparently', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		await config.set({
			appUpdatePollInterval: 30000,
			name: 'a new device name',
		});
		const values = await config.getMany(['appUpdatePollInterval', 'name']);
		return expect(values).to.deep.equal({
			appUpdatePollInterval: 30000,
			name: 'a new device name',
		});
	});

	it('allows deleting a config.json key and returns a default value if none is set', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		await config.remove('appUpdatePollInterval');
		const poll = await config.get('appUpdatePollInterval');
		return expect(poll).to.equal(900000);
	});

	it('allows deleting a config.json key if it is null', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		await config.set({ apiKey: null });
		const key = await config.get('apiKey');

		expect(key).to.be.undefined;

		// config.json should have been modified as well
		const configJson = await readConfigJson();
		expect(configJson.apiKey).to.be.undefined;
	});

	it('does not allow modifying or removing a function value', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		// We have to cast to any below, as the type system will
		// not allow removing a function value
		await expect(config.remove('version' as any)).to.be.rejected;
		await expect(config.set({ version: '2.0' })).to.be.rejected;
	});

	it('throws when asked for an unknown key', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		await expect(config.get('unknownInvalidValue' as any)).to.be.rejected;
	});

	it('emits a change event when values change', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		const listener = stub();
		config.on('change', listener);
		config.set({ name: 'someValue' });

		await new Promise((resolve) => setTimeout(resolve, 1000));

		expect(listener).to.have.been.calledWith({ name: 'someValue' });
	});

	// FIXME: this test illustrates the issue with the singleton approach and the
	// "load config as you go" approach.
	// The `osVariant` comes from a function in `src/config/functions` and that function
	// memoizes the contents of `/etc/os-variant`.
	// Since previous invocations have already memoized that value, there is no good way
	// to force the config module to reload the file.
	// The config module instead could read all static data on initialization and
	// forget about memoization
	// this is being skipped until the config module can be refactored
	it.skip('deduces OS variant from developmentMode if not set', async () => {
		const tFs = await testfs({
			'/mnt/root/etc/os-release': testfs.from(
				'test/data/etc/os-release-novariant',
			),
		}).enable();

		const config = await import('~/src/config');
		await config.initialized();
		await config.set({ developmentMode: false });

		const osVariant = await config.get('osVariant');
		expect(osVariant).to.equal('prod');

		await tFs.restore();
	});

	it('reads and exposes MAC addresses', async () => {
		const config = await import('~/src/config');
		await config.initialized();
		const macAddress = await config.get('macAddress');
		expect(macAddress).to.have.length.greaterThan(0);
	});

	describe('Function config providers', () => {
		it('should throw if a non-mutable function provider is set', async () => {
			const config = await import('~/src/config');
			await config.initialized();
			await expect(config.set({ version: 'some-version' })).to.be.rejected;
		});

		it('should throw if a non-mutable function provider is removed', async () => {
			const config = await import('~/src/config');
			await config.initialized();
			await expect(config.remove('version' as any)).to.be.rejected;
		});
	});

	describe('Config data sources', () => {
		afterEach(() => {
			// Clean up memoized values
			fnSchema.deviceArch.clear();
			fnSchema.deviceType.clear();
		});

		it('should obtain deviceArch from device-type.json', async () => {
			const dtJson = await readDeviceTypeJson();
			const config = await import('~/src/config');
			await config.initialized();

			const deviceArch = await config.get('deviceArch');
			expect(deviceArch).to.equal(dtJson.arch);
		});

		it('should obtain deviceType from device-type.json', async () => {
			const dtJson = await readDeviceTypeJson();
			const config = await import('~/src/config');
			await config.initialized();

			const deviceArch = await config.get('deviceType');
			expect(deviceArch).to.equal(dtJson.slug);
		});

		it('should memoize values from device-type.json', async () => {
			const config = await import('~/src/config');
			await config.initialized();
			const dtJson = await readDeviceTypeJson();
			spy(hostUtils, 'readFromBoot');

			// Make a first call to get the value to be memoized
			await config.get('deviceType');
			await config.get('deviceArch');
			expect(hostUtils.readFromBoot).to.be.called;
			(hostUtils.readFromBoot as SinonSpy).resetHistory();

			const deviceArch = await config.get('deviceArch');
			expect(deviceArch).to.equal(dtJson.arch);

			// The result should still be memoized from the previous call
			expect(hostUtils.readFromBoot).to.not.be.called;

			const deviceType = await config.get('deviceType');
			expect(deviceType).to.equal(dtJson.slug);

			// The result should still be memoized from the previous call
			expect(hostUtils.readFromBoot).to.not.be.called;

			(hostUtils.readFromBoot as SinonSpy).restore();
		});

		it('should not memoize errors when reading deviceArch', async () => {
			const config = await import('~/src/config');
			await config.initialized();

			const tfs = await testfs({}, { keep: [deviceTypeJsonPath] }).enable();

			// Remove the file before the test
			await fs.unlink(deviceTypeJsonPath).catch(() => {
				/* noop */
			});

			await expect(config.get('deviceArch')).to.eventually.equal('unknown');

			// Restore the file before trying again
			await tfs.restore();

			const dtJson = await readDeviceTypeJson();
			await expect(config.get('deviceArch')).to.eventually.equal(dtJson.arch);
		});

		it('should not memoize errors when reading deviceType', async () => {
			const config = await import('~/src/config');
			await config.initialized();

			const tfs = await testfs({}, { keep: [deviceTypeJsonPath] }).enable();
			// Remove the file before the test
			await fs.unlink(deviceTypeJsonPath).catch(() => {
				/* noop */
			});

			await expect(config.get('deviceType')).to.eventually.equal('unknown');

			// Restore the file before trying again
			await tfs.restore();

			const dtJson = await readDeviceTypeJson();
			await expect(config.get('deviceType')).to.eventually.equal(dtJson.slug);
		});
	});
});
