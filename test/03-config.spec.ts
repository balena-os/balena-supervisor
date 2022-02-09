import * as _ from 'lodash';
import { promises as fs } from 'fs';
import { SinonStub, stub } from 'sinon';
import { expect } from 'chai';

import prepare = require('./lib/prepare');
import * as conf from '../src/config';

import constants = require('../src/lib/constants');
import { SchemaTypeKey } from '../src/config/schema-type';
import { fnSchema } from '../src/config/functions';

describe('Config', () => {
	before(async () => {
		await prepare();
		await conf.initialized;
	});

	it('reads and exposes values from the config.json', async () => {
		const id = await conf.get('applicationId');
		return expect(id).to.equal(78373);
	});

	it('allows reading several values in one getMany call', async () => {
		return expect(
			await conf.getMany(['applicationId', 'apiEndpoint']),
		).to.deep.equal({
			applicationId: 78373,
			apiEndpoint: 'https://api.resin.io',
		});
	});

	it('generates a uuid and stores it in config.json', async () => {
		const uuid = await conf.get('uuid');
		const configJsonUuid = JSON.parse(
			await fs.readFile('./test/data/config.json', 'utf8'),
		).uuid;
		expect(uuid).to.be.a('string');
		expect(uuid).to.have.lengthOf(32);
		expect(uuid).to.equal(configJsonUuid);
	});

	it('does not allow setting an immutable field', async () => {
		const promise = conf.set({ deviceType: 'a different device type' });
		// We catch it to avoid the unhandled error log
		promise.catch(_.noop);
		return expect(promise).to.be.rejected;
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
		expect(
			JSON.parse(await fs.readFile('./test/data/config.json', 'utf8')),
		).to.not.have.property('apiKey');
	});

	it('does not allow modifying or removing a function value', () => {
		// We have to cast to any below, as the type system will
		// not allow removing a function value
		expect(conf.remove('version' as any)).to.be.rejected;
		expect(conf.set({ version: '2.0' })).to.be.rejected;
	});

	it('throws when asked for an unknown key', () => {
		expect(conf.get('unknownInvalidValue' as any)).to.be.rejected;
	});

	it('emits a change event when values', (done) => {
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

	it("returns production OS variant if it doesn't exist", async () => {
		const oldPath = constants.hostOSVersionPath;
		constants.hostOSVersionPath = 'test/data/etc/os-release-novariant';

		const osVariant = await conf.get('osVariant');
		constants.hostOSVersionPath = oldPath;
		expect(osVariant).to.equal('prod');
	});

	it('reads and exposes MAC addresses', async () => {
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
		after(() => {
			// Clean up memoized values
		});

		it('should obtain deviceArch from device-type.json', async () => {
			const [slug, arch] = ['raspberrypi3', 'armv7hf'];
			stub(fs, 'readFile').resolves(
				JSON.stringify({
					slug,
					arch,
				}),
			);

			const deviceArch = await conf.get('deviceArch');
			expect(deviceArch).to.equal(arch);
			expect(fs.readFile).to.be.calledOnce;
			expect(fs.readFile).to.be.calledWith(
				`${constants.rootMountPoint}${constants.bootMountPoint}/device-type.json`,
				'utf8',
			);

			(fs.readFile as SinonStub).restore();
		});

		it('should obtain deviceType from device-type.json', async () => {
			const [slug, arch] = ['raspberrypi3', 'armv7hf'];
			stub(fs, 'readFile').resolves(
				JSON.stringify({
					slug,
					arch,
				}),
			);

			const deviceType = await conf.get('deviceType');
			expect(deviceType).to.equal(slug);
			expect(fs.readFile).to.be.calledOnce;
			expect(fs.readFile).to.be.calledWith(
				`${constants.rootMountPoint}${constants.bootMountPoint}/device-type.json`,
				'utf8',
			);

			(fs.readFile as SinonStub).restore();
		});

		it('should memoize values from device-type.json', async () => {
			const [slug, arch] = ['raspberrypi3', 'armv7hf'];
			stub(fs, 'readFile').resolves(
				JSON.stringify({
					slug,
					arch,
				}),
			);

			const deviceArch = await conf.get('deviceArch');
			expect(deviceArch).to.equal(arch);

			// The result should still be memoized from the
			// call on the previous test
			expect(fs.readFile).to.not.be.called;

			const deviceType = await conf.get('deviceType');
			expect(deviceType).to.equal(slug);

			// The result should still be memoized from the
			// call on the previous test
			expect(fs.readFile).to.not.be.called;

			(fs.readFile as SinonStub).restore();
		});

		it('should not memoize errors when reading deviceArch', (done) => {
			// Clean up memoized value
			fnSchema.deviceArch.clear();

			// File not found
			stub(fs, 'readFile').throws('File not found');

			expect(conf.get('deviceArch')).to.eventually.equal('unknown');
			expect(fs.readFile).to.be.calledOnce;
			(fs.readFile as SinonStub).restore();

			// Next call should not throw
			const [slug, arch] = ['raspberrypi3', 'armv7hf'];
			stub(fs, 'readFile').resolves(
				JSON.stringify({
					slug,
					arch,
				}),
			);

			// We need to let rejection be discovered
			// https://github.com/medikoo/memoizee/issues/93
			setTimeout(() => {
				expect(conf.get('deviceArch')).to.eventually.equal(arch);
				expect(fs.readFile).to.be.calledOnce;
				(fs.readFile as SinonStub).restore();
				done();
			});
		});

		it('should not memoize errors when reading deviceType', (done) => {
			// Clean up memoized value
			fnSchema.deviceType.clear();

			// File not found
			stub(fs, 'readFile').throws('File not found');

			expect(conf.get('deviceType')).to.eventually.equal('unknown');
			expect(fs.readFile).to.be.calledOnce;
			(fs.readFile as SinonStub).restore();

			// Next call should not throw
			const [slug, arch] = ['raspberrypi3', 'armv7hf'];
			stub(fs, 'readFile').resolves(
				JSON.stringify({
					slug,
					arch,
				}),
			);

			// We need to let rejection be discovered
			// https://github.com/medikoo/memoizee/issues/93
			setTimeout(() => {
				expect(conf.get('deviceType')).to.eventually.equal(slug);
				expect(fs.readFile).to.be.calledOnce;
				(fs.readFile as SinonStub).restore();
				done();
			});
		});
	});
});
