import * as _ from 'lodash';
import * as path from 'path';
import { promises as fs } from 'fs';
import { SinonSpy, spy, SinonStub, stub } from 'sinon';
import { expect } from 'chai';
import { testfs, TestFs } from 'mocha-pod';

import constants = require('~/lib/constants');
import { SchemaTypeKey } from '~/src/config/schema-type';
import { fnSchema } from '~/src/config/functions';

import * as conf from '~/src/config';

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

	before(async () => {
		await conf.initialized();
	});

	beforeEach(async () => {
		// This tells testfs to make a backup of config.json before each test
		// as some of the tests modify the file. This prevents any leaking between
		// tests
		testFs = await testfs({}, { keep: [configJsonPath] }).enable();
	});

	afterEach(async () => {
		await testFs.restore();
	});

	it('reads and exposes values from config.json', async () => {
		const configJson = await readConfigJson();
		const id = await conf.get('applicationId');
		return expect(id).to.equal(configJson.applicationId);
	});

	it('allows reading several values in one getMany call', async () => {
		const configJson = await readConfigJson();
		return expect(
			await conf.getMany(['applicationId', 'apiEndpoint']),
		).to.deep.equal({
			applicationId: configJson.applicationId,
			apiEndpoint: configJson.apiEndpoint,
		});
	});

	it('generates a uuid and stores it in config.json', async () => {
		const configJson = await readConfigJson();
		const uuid = await conf.get('uuid');
		expect(uuid).to.be.a('string');
		expect(uuid).to.have.lengthOf(32);
		expect(uuid).to.equal(configJson.uuid);
	});

	it('does not allow setting an immutable field', async () => {
		return expect(conf.set({ deviceType: 'a different device type' })).to.be
			.rejected;
	});

	it('allows setting both config.json and database fields transparently', async () => {
		await conf.set({ appUpdatePollInterval: 30000, name: 'a new device name' });
		const config = await conf.getMany(['appUpdatePollInterval', 'name']);
		return expect(config).to.deep.equal({
			appUpdatePollInterval: 30000,
			name: 'a new device name',
		});
	});

	it('allows deleting a config.json key and returns a default value if none is set', async () => {
		await conf.remove('appUpdatePollInterval');
		const poll = await conf.get('appUpdatePollInterval');
		return expect(poll).to.equal(900000);
	});

	it('allows deleting a config.json key if it is null', async () => {
		await conf.set({ apiKey: null });
		const key = await conf.get('apiKey');

		expect(key).to.be.undefined;

		// config.json should have been modified as well
		const configJson = await readConfigJson();
		expect(configJson.apiKey).to.be.undefined;
	});

	it('does not allow modifying or removing a function value', async () => {
		// We have to cast to any below, as the type system will
		// not allow removing a function value
		await expect(conf.remove('version' as any)).to.be.rejected;
		await expect(conf.set({ version: '2.0' })).to.be.rejected;
	});

	it('throws when asked for an unknown key', () => {
		return expect(conf.get('unknownInvalidValue' as any)).to.be.rejected;
	});

	it('emits a change event when values change', (done) => {
		const listener = (val: conf.ConfigChangeMap<SchemaTypeKey>) => {
			try {
				if ('name' in val) {
					expect(val.name).to.equal('someValue');
					done();
					conf.removeListener('change', listener);
				}
			} catch (e) {
				done(e);
			}
		};
		conf.on('change', listener);
		conf.set({ name: 'someValue' });
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

		await conf.set({ developmentMode: false });

		const osVariant = await conf.get('osVariant');
		expect(osVariant).to.equal('prod');

		await tFs.restore();
	});

	it('reads and exposes MAC addresses', async () => {
		// FIXME: this variable defaults to `/mnt/root/sys/class/net`. The supervisor runs with network_mode: false
		// which means that it can just use the container `/sys/class/net` and the result should be the same
		constants.macAddressPath = '/sys/class/net';
		const macAddress = await conf.get('macAddress');
		expect(macAddress).to.have.length.greaterThan(0);
	});

	describe('Function config providers', () => {
		it('should throw if a non-mutable function provider is set', () => {
			expect(conf.set({ version: 'some-version' })).to.be.rejected;
		});

		it('should throw if a non-mutable function provider is removed', () => {
			expect(conf.remove('version' as any)).to.be.rejected;
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

			const deviceArch = await conf.get('deviceArch');
			expect(deviceArch).to.equal(dtJson.arch);
		});

		it('should obtain deviceType from device-type.json', async () => {
			const dtJson = await readDeviceTypeJson();

			const deviceArch = await conf.get('deviceType');
			expect(deviceArch).to.equal(dtJson.slug);
		});

		it('should memoize values from device-type.json', async () => {
			const dtJson = await readDeviceTypeJson();
			spy(fs, 'readFile');

			// Make a first call to get the value to be memoized
			await conf.get('deviceType');
			await conf.get('deviceArch');
			expect(fs.readFile).to.be.called;
			(fs.readFile as SinonSpy).resetHistory();

			const deviceArch = await conf.get('deviceArch');
			expect(deviceArch).to.equal(dtJson.arch);

			// The result should still be memoized from the previous call
			expect(fs.readFile).to.not.be.called;

			const deviceType = await conf.get('deviceType');
			expect(deviceType).to.equal(dtJson.slug);

			// The result should still be memoized from the previous call
			expect(fs.readFile).to.not.be.called;

			(fs.readFile as SinonSpy).restore();
		});

		it('should not memoize errors when reading deviceArch', async () => {
			// File not found
			stub(fs, 'readFile').rejects('File not found');

			await expect(conf.get('deviceArch')).to.eventually.equal('unknown');
			expect(fs.readFile).to.be.calledOnce;
			(fs.readFile as SinonStub).restore();

			const dtJson = await readDeviceTypeJson();
			await expect(conf.get('deviceArch')).to.eventually.equal(dtJson.arch);
		});

		it('should not memoize errors when reading deviceType', async () => {
			// File not found
			stub(fs, 'readFile').rejects('File not found');

			await expect(conf.get('deviceType')).to.eventually.equal('unknown');
			expect(fs.readFile).to.be.calledOnce;
			(fs.readFile as SinonStub).restore();

			const dtJson = await readDeviceTypeJson();
			await expect(conf.get('deviceType')).to.eventually.equal(dtJson.slug);
		});
	});
});
