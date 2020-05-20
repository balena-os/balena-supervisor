import { stripIndent } from 'common-tags';
import { fs } from 'mz';
import { Server } from 'net';
import { SinonSpy, SinonStub, spy, stub } from 'sinon';

import ApiBinder from '../src/api-binder';
import Config from '../src/config';
import DeviceState from '../src/device-state';
import Log from '../src/lib/supervisor-console';
import chai = require('./lib/chai-config');
import balenaAPI = require('./lib/mocked-balena-api');
import prepare = require('./lib/prepare');

const { expect } = chai;

const initModels = async (obj: Dictionary<any>, filename: string) => {
	await prepare();

	obj.config = new Config({ configPath: filename });

	obj.eventTracker = {
		track: stub().callsFake((ev, props) => console.log(ev, props)),
	} as any;

	obj.logger = {
		clearOutOfDateDBLogs: () => {
			/* noop */
		},
	} as any;

	obj.apiBinder = new ApiBinder({
		config: obj.config,
		logger: obj.logger,
		eventTracker: obj.eventTracker,
	});

	obj.deviceState = new DeviceState({
		config: obj.config,
		eventTracker: obj.eventTracker,
		logger: obj.logger,
		apiBinder: obj.apiBinder,
	});

	obj.apiBinder.setDeviceState(obj.deviceState);

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

		it('exchanges keys if resource conflict when provisioning', async () => {
			// Get current config to extend
			const currentConfig = await components.apiBinder.config.get(
				'provisioningOptions',
			);
			// Stub config values so we have correct conditions
			const configStub = stub(Config.prototype, 'get').resolves({
				...currentConfig,
				registered_at: null,
				provisioningApiKey: '123', // Previous test case deleted the provisioningApiKey so add one
				uuid: 'not-unique', // This UUID is used in mocked-balena-api as an existing registered UUID
			});
			// If api-binder reaches this function then tests pass
			const functionToReach = stub(
				components.apiBinder,
				'exchangeKeyAndGetDeviceOrRegenerate',
			).rejects('expected-rejection'); // We throw an error so we don't have to keep stubbing
			spy(Log, 'debug');

			try {
				await components.apiBinder.provision();
			} catch (e) {
				// Check that the error thrown is from this test
				if (e.name !== 'expected-rejection') {
					throw e;
				}
			}

			expect(functionToReach).to.be.calledOnce;
			expect((Log.debug as SinonSpy).lastCall.lastArg).to.equal(
				'UUID already registered, trying a key exchange',
			);

			// Restore stubs
			functionToReach.restore();
			configStub.restore();
			(Log.debug as SinonStub).restore();
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

	describe('healthchecks', () => {
		const components: Dictionary<any> = {};
		let configStub: SinonStub;
		let infoLobSpy: SinonSpy;

		before(() => {
			initModels(components, '/config-apibinder.json');
		});

		beforeEach(() => {
			// This configStub will be modified in each test case so we can
			// create the exact conditions we want to for testing healthchecks
			configStub = stub(Config.prototype, 'getMany');
			infoLobSpy = spy(Log, 'info');
		});

		afterEach(() => {
			configStub.restore();
			infoLobSpy.restore();
		});

		it('passes with correct conditions', async () => {
			// Set unmanaged to false so we check all values
			// The other values are stubbed to make it pass
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: 1000,
				connectivityCheckEnabled: false,
			});
			expect(await components.apiBinder.healthcheck()).to.equal(true);
		});

		it('passes if unmanaged is true and exit early', async () => {
			// Setup failing conditions
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: null,
				connectivityCheckEnabled: false,
			});
			// Verify this causes healthcheck to fail
			expect(await components.apiBinder.healthcheck()).to.equal(false);
			// Do it again but set unmanaged to true
			configStub.resolves({
				unmanaged: true,
				appUpdatePollInterval: null,
				connectivityCheckEnabled: false,
			});
			expect(await components.apiBinder.healthcheck()).to.equal(true);
		});

		it('fails if appUpdatePollInterval not set in config and exit early', async () => {
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: null,
				connectivityCheckEnabled: false,
			});
			expect(await components.apiBinder.healthcheck()).to.equal(false);
			expect(Log.info).to.be.calledOnce;
			expect((Log.info as SinonSpy).lastCall?.lastArg).to.equal(
				'Healthcheck failure - Config value `appUpdatePollInterval` cannot be null',
			);
		});

		it("fails when hasn't checked target state within poll interval", async () => {
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: 1,
				connectivityCheckEnabled: false,
			});
			expect(await components.apiBinder.healthcheck()).to.equal(false);
			expect(Log.info).to.be.calledOnce;
			expect((Log.info as SinonSpy).lastCall?.lastArg).to.equal(
				'Healthcheck failure - Device has not fetched target state within appUpdatePollInterval limit',
			);
		});

		it('fails when stateReportHealthy is false', async () => {
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: 1000,
				connectivityCheckEnabled: true,
			});
			// Copy previous values to restore later
			const previousStateReportErrors = components.apiBinder.stateReportErrors;
			const previousDeviceStateConnected =
				components.apiBinder.deviceState.connected;
			// Set additional conditions not in configStub to cause a fail
			components.apiBinder.stateReportErrors = 4;
			components.apiBinder.deviceState.connected = true;
			expect(await components.apiBinder.healthcheck()).to.equal(false);
			expect(Log.info).to.be.calledOnce;
			expect((Log.info as SinonSpy).lastCall?.lastArg).to.equal(
				stripIndent`
				Healthcheck failure - Atleast ONE of the following conditions must be true:
					- No connectivityCheckEnabled   ? false
					- device state is disconnected  ? false
					- stateReportErrors less then 3 ? false`,
			);
			// Restore previous values
			components.apiBinder.stateReportErrors = previousStateReportErrors;
			components.apiBinder.deviceState.connected = previousDeviceStateConnected;
		});
	});
});
