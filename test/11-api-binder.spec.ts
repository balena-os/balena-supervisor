import { fs } from 'mz';
import { Server } from 'net';
import { spy, stub } from 'sinon';

import chai = require('./lib/chai-config');
import balenaAPI = require('./lib/mocked-balena-api');
import prepare = require('./lib/prepare');

const { expect } = chai;

import ApiBinder from '../src/api-binder';
import Config from '../src/config';
import DB from '../src/db';
import DeviceState from '../src/device-state';

const initModels = async (obj: Dictionary<any>, filename: string) => {
	prepare();

	obj.db = new DB();
	obj.config = new Config({ db: obj.db, configPath: filename });

	obj.eventTracker = {
		track: stub().callsFake((ev, props) => console.log(ev, props)),
	} as any;

	obj.logger = {
		clearOutOfDateDBLogs: () => {
			/* noop */
		},
	} as any;

	obj.deviceState = new DeviceState({
		db: obj.db,
		config: obj.config,
		eventTracker: obj.eventTracker,
		logger: obj.logger,
	});

	obj.apiBinder = new ApiBinder({
		db: obj.db,
		config: obj.config,
		logger: obj.logger,
		eventTracker: obj.eventTracker,
		deviceState: obj.deviceState,
	});
	await obj.db.init();
	await obj.config.init();
	await obj.apiBinder.initClient(); // Initializes the clients but doesn't trigger provisioning
};

const mockProvisioningOpts = {
	apiEndpoint: 'http://0.0.0.0:3000',
	uuid: 'abcd',
	deviceApiKey: 'averyvalidkey',
	provisioningApiKey: 'anotherveryvalidkey',
	apiTimeout: 30000,
};

describe('ApiBinder', () => {
	let server: Server;

	before(() => {
		spy(balenaAPI.balenaBackend!, 'registerHandler');
		server = balenaAPI.listen(3000);
	});

	after(() => {
		// @ts-ignore
		balenaAPI.balenaBackend!.registerHandler.restore();
		try {
			server.close();
		} catch (error) {
			/* noop */
		}
	});

	// We do not support older OS versions anymore, so we only test this case
	describe('on an OS with deviceApiKey support', () => {
		const components: Dictionary<any> = {};
		before(() => {
			return initModels(components, '/config-apibinder.json');
		});

		it('provisions a device', () => {
			// @ts-ignore
			const promise = components.apiBinder.provisionDevice();

			return expect(promise).to.be.fulfilled.then(() => {
				expect(balenaAPI.balenaBackend!.registerHandler).to.be.calledOnce;

				// @ts-ignore
				balenaAPI.balenaBackend!.registerHandler.resetHistory();
				expect(components.eventTracker.track).to.be.calledWith(
					'Device bootstrap success',
				);
			});
		});

		it('deletes the provisioning key', async () => {
			expect(await components.config.get('apiKey')).to.be.undefined;
		});

		it('sends the correct parameters when provisioning', async () => {
			const conf = JSON.parse(
				await fs.readFile('./test/data/config-apibinder.json', 'utf8'),
			);
			expect(balenaAPI.balenaBackend!.devices).to.deep.equal({
				'1': {
					id: 1,
					user: conf.userId,
					application: conf.applicationId,
					uuid: conf.uuid,
					device_type: conf.deviceType,
					api_key: conf.deviceApiKey,
				},
			});
		});
	});

	describe('fetchDevice', () => {
		const components: Dictionary<any> = {};
		before(() => {
			return initModels(components, '/config-apibinder.json');
		});

		it('gets a device by its uuid from the balena API', async () => {
			// Manually add a device to the mocked API
			balenaAPI.balenaBackend!.devices[3] = {
				id: 3,
				user: 'foo',
				application: 1337,
				uuid: 'abcd',
				device_type: 'intel-nuc',
				api_key: 'verysecure',
			};

			const device = await components.apiBinder.fetchDevice(
				'abcd',
				'someApiKey',
				30000,
			);
			expect(device).to.deep.equal(balenaAPI.balenaBackend!.devices[3]);
		});
	});

	describe('exchangeKeyAndGetDevice', () => {
		const components: Dictionary<any> = {};
		before(() => {
			return initModels(components, '/config-apibinder.json');
		});

		it('returns the device if it can fetch it with the deviceApiKey', async () => {
			spy(balenaAPI.balenaBackend!, 'deviceKeyHandler');

			const fetchDeviceStub = stub(components.apiBinder, 'fetchDevice');
			fetchDeviceStub.onCall(0).resolves({ id: 1 });

			// @ts-ignore
			const device = await components.apiBinder.exchangeKeyAndGetDevice(
				mockProvisioningOpts,
			);

			expect(balenaAPI.balenaBackend!.deviceKeyHandler).to.not.be.called;
			expect(device).to.deep.equal({ id: 1 });
			expect(components.apiBinder.fetchDevice).to.be.calledOnce;

			// @ts-ignore
			components.apiBinder.fetchDevice.restore();
			// @ts-ignore
			balenaAPI.balenaBackend.deviceKeyHandler.restore();
		});

		it('throws if it cannot get the device with any of the keys', () => {
			spy(balenaAPI.balenaBackend!, 'deviceKeyHandler');
			stub(components.apiBinder, 'fetchDevice').returns(Promise.resolve(null));

			// @ts-ignore
			const promise = components.apiBinder.exchangeKeyAndGetDevice(
				mockProvisioningOpts,
			);
			promise.catch(() => {
				/* noop */
			});

			return expect(promise).to.be.rejected.then(() => {
				expect(balenaAPI.balenaBackend!.deviceKeyHandler).to.not.be.called;
				expect(components.apiBinder.fetchDevice).to.be.calledTwice;
				// @ts-ignore
				components.apiBinder.fetchDevice.restore();
				// @ts-ignore
				balenaAPI.balenaBackend.deviceKeyHandler.restore();
			});
		});

		it('exchanges the key and returns the device if the provisioning key is valid', async () => {
			spy(balenaAPI.balenaBackend!, 'deviceKeyHandler');
			const fetchDeviceStub = stub(components.apiBinder, 'fetchDevice');
			fetchDeviceStub.onCall(0).returns(Promise.resolve(null));
			fetchDeviceStub.onCall(1).returns(Promise.resolve({ id: 1 }));

			// @ts-ignore
			const device = await components.apiBinder.exchangeKeyAndGetDevice(
				mockProvisioningOpts as any,
			);
			expect(balenaAPI.balenaBackend!.deviceKeyHandler).to.be.calledOnce;
			expect(device).to.deep.equal({ id: 1 });
			expect(components.apiBinder.fetchDevice).to.be.calledTwice;
			// @ts-ignore
			components.apiBinder.fetchDevice.restore();
			// @ts-ignore
			balenaAPI.balenaBackend.deviceKeyHandler.restore();
		});
	});

	describe('unmanaged mode', () => {
		const components: Dictionary<any> = {};
		before(() => {
			return initModels(components, '/config-apibinder-offline.json');
		});

		it('does not generate a key if the device is in unmanaged mode', async () => {
			const mode = await components.config.get('unmanaged');
			// Ensure offline mode is set
			expect(mode).to.equal(true);
			// Check that there is no deviceApiKey
			const conf = await components.config.getMany(['deviceApiKey', 'uuid']);
			expect(conf['deviceApiKey']).to.be.empty;
			expect(conf['uuid']).to.not.be.undefined;
		});

		describe('Minimal config unmanaged mode', () => {
			const components2: Dictionary<any> = {};
			before(() => {
				return initModels(components2, '/config-apibinder-offline2.json');
			});

			it('does not generate a key with the minimal config', async () => {
				const mode = await components2.config.get('unmanaged');
				expect(mode).to.equal(true);
				const conf = await components2.config.getMany(['deviceApiKey', 'uuid']);
				expect(conf['deviceApiKey']).to.be.empty;
				return expect(conf['uuid']).to.not.be.undefined;
			});
		});
	});
});
