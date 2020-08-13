import * as _ from 'lodash';
import { SinonSpy, SinonStub, spy, stub } from 'sinon';

import chai = require('./lib/chai-config');
import { StatusCodeError } from '../src/lib/errors';
import prepare = require('./lib/prepare');
import Log from '../src/lib/supervisor-console';
import { RPiConfigBackend } from '../src/config/backends/raspberry-pi';
import { loadTargetFromFile } from '../src/device-state/preload';
import * as images from '../src/compose/images';
import Service from '../src/compose/service';
import { intialiseContractRequirements } from '../src/lib/contracts';

import * as config from '../src/config';
import * as deviceConfig from '../src/device-config';
import * as dockerUtils from '../src/lib/docker-utils';
import * as deviceState from '../src/device-state';

import { getTargetJson } from '../src/device-state/db-format';

// tslint:disable-next-line
chai.use(require('chai-events'));
const { expect } = chai;

const mockedInitialConfig = {
	RESIN_SUPERVISOR_CONNECTIVITY_CHECK: 'true',
	RESIN_SUPERVISOR_DELTA: 'false',
	RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT: '0',
	RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT: '30000',
	RESIN_SUPERVISOR_DELTA_RETRY_COUNT: '30',
	RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL: '10000',
	RESIN_SUPERVISOR_DELTA_VERSION: '2',
	RESIN_SUPERVISOR_INSTANT_UPDATE_TRIGGER: 'true',
	RESIN_SUPERVISOR_LOCAL_MODE: 'false',
	RESIN_SUPERVISOR_LOG_CONTROL: 'true',
	RESIN_SUPERVISOR_OVERRIDE_LOCK: 'false',
	RESIN_SUPERVISOR_POLL_INTERVAL: '60000',
	RESIN_SUPERVISOR_VPN_CONTROL: 'true',
};

const testTarget1 = {
	local: {
		name: 'aDevice',
		config: {
			HOST_CONFIG_gpu_mem: '256',
			HOST_FIREWALL_MODE: 'off',
			HOST_DISCOVERABILITY: 'true',
			SUPERVISOR_CONNECTIVITY_CHECK: 'true',
			SUPERVISOR_DELTA: 'false',
			SUPERVISOR_DELTA_APPLY_TIMEOUT: '0',
			SUPERVISOR_DELTA_REQUEST_TIMEOUT: '30000',
			SUPERVISOR_DELTA_RETRY_COUNT: '30',
			SUPERVISOR_DELTA_RETRY_INTERVAL: '10000',
			SUPERVISOR_DELTA_VERSION: '2',
			SUPERVISOR_INSTANT_UPDATE_TRIGGER: 'true',
			SUPERVISOR_LOCAL_MODE: 'false',
			SUPERVISOR_LOG_CONTROL: 'true',
			SUPERVISOR_OVERRIDE_LOCK: 'false',
			SUPERVISOR_POLL_INTERVAL: '60000',
			SUPERVISOR_VPN_CONTROL: 'true',
			SUPERVISOR_PERSISTENT_LOGGING: 'false',
		},
		apps: {
			'1234': {
				appId: 1234,
				name: 'superapp',
				commit: 'abcdef',
				releaseId: 1,
				services: {
					23: {
						appId: 1234,
						serviceId: 23,
						imageId: 12345,
						serviceName: 'someservice',
						environment: {},
						releaseId: 1,
						image: 'registry2.resin.io/superapp/abcdef:latest',
						labels: {
							'io.resin.something': 'bar',
						},
					},
				},
				volumes: {},
				networks: {},
			},
		},
	},
	dependent: { apps: [], devices: [] },
};

const testTarget2 = {
	local: {
		name: 'aDeviceWithDifferentName',
		config: {
			RESIN_HOST_CONFIG_gpu_mem: '512',
		},
		apps: {
			'1234': {
				name: 'superapp',
				commit: 'afafafa',
				releaseId: 2,
				services: {
					'23': {
						serviceName: 'aservice',
						imageId: 12345,
						image: 'registry2.resin.io/superapp/edfabc',
						environment: {
							FOO: 'bar',
						},
						labels: {},
					},
					'24': {
						serviceName: 'anotherService',
						imageId: 12346,
						image: 'registry2.resin.io/superapp/afaff',
						environment: {
							FOO: 'bro',
						},
						labels: {},
					},
				},
				volumes: {},
				networks: {},
			},
		},
	},
	dependent: { apps: [], devices: [] },
};

const testTargetWithDefaults2 = {
	local: {
		name: 'aDeviceWithDifferentName',
		config: {
			HOST_CONFIG_gpu_mem: '512',
			HOST_FIREWALL_MODE: 'off',
			HOST_DISCOVERABILITY: 'true',
			SUPERVISOR_CONNECTIVITY_CHECK: 'true',
			SUPERVISOR_DELTA: 'false',
			SUPERVISOR_DELTA_APPLY_TIMEOUT: '0',
			SUPERVISOR_DELTA_REQUEST_TIMEOUT: '30000',
			SUPERVISOR_DELTA_RETRY_COUNT: '30',
			SUPERVISOR_DELTA_RETRY_INTERVAL: '10000',
			SUPERVISOR_DELTA_VERSION: '2',
			SUPERVISOR_INSTANT_UPDATE_TRIGGER: 'true',
			SUPERVISOR_LOCAL_MODE: 'false',
			SUPERVISOR_LOG_CONTROL: 'true',
			SUPERVISOR_OVERRIDE_LOCK: 'false',
			SUPERVISOR_POLL_INTERVAL: '60000',
			SUPERVISOR_VPN_CONTROL: 'true',
			SUPERVISOR_PERSISTENT_LOGGING: 'false',
		},
		apps: {
			'1234': {
				appId: 1234,
				name: 'superapp',
				commit: 'afafafa',
				releaseId: 2,
				services: [
					_.merge(
						{ appId: 1234, serviceId: 23, releaseId: 2 },
						_.clone(testTarget2.local.apps['1234'].services['23']),
					),
					_.merge(
						{ appId: 1234, serviceId: 24, releaseId: 2 },
						_.clone(testTarget2.local.apps['1234'].services['24']),
					),
				],
				volumes: {},
				networks: {},
			},
		},
	},
	dependent: { apps: [], devices: [] },
};

const testTargetInvalid = {
	local: {
		name: 'aDeviceWithDifferentName',
		config: {
			RESIN_HOST_CONFIG_gpu_mem: '512',
		},
		apps: {
			1234: {
				appId: '1234',
				name: 'superapp',
				commit: 'afafafa',
				releaseId: '2',
				config: {},
				services: {
					23: {
						serviceId: '23',
						serviceName: 'aservice',
						imageId: '12345',
						image: 'registry2.resin.io/superapp/edfabc',
						config: {},
						environment: {
							' FOO': 'bar',
						},
						labels: {},
					},
					24: {
						serviceId: '24',
						serviceName: 'anotherService',
						imageId: '12346',
						image: 'registry2.resin.io/superapp/afaff',
						config: {},
						environment: {
							FOO: 'bro',
						},
						labels: {},
					},
				},
			},
		},
	},
	dependent: { apps: [], devices: [] },
};

describe('deviceState', () => {
	let source: string;
	const originalImagesSave = images.save;
	const originalImagesInspect = images.inspectByName;
	const originalGetCurrent = deviceConfig.getCurrent;

	before(async () => {
		await prepare();
		await config.initialized;
		await deviceState.initialized;

		source = await config.get('apiEndpoint');

		stub(Service as any, 'extendEnvVars').callsFake((env) => {
			env['ADDITIONAL_ENV_VAR'] = 'foo';
			return env;
		});

		intialiseContractRequirements({
			supervisorVersion: '11.0.0',
			deviceType: 'intel-nuc',
		});

		stub(dockerUtils, 'getNetworkGateway').returns(
			Promise.resolve('172.17.0.1'),
		);

		// @ts-expect-error Assigning to a RO property
		images.cleanupDatabase = () => {
			console.log('Cleanup database called');
		};

		// @ts-expect-error Assigning to a RO property
		images.save = () => Promise.resolve();

		// @ts-expect-error Assigning to a RO property
		images.inspectByName = () => {
			const err: StatusCodeError = new Error();
			err.statusCode = 404;
			return Promise.reject(err);
		};

		// @ts-expect-error Assigning to a RO property
		deviceConfig.configBackend = new RPiConfigBackend();

		// @ts-expect-error Assigning to a RO property
		deviceConfig.getCurrent = async () => mockedInitialConfig;
	});

	after(() => {
		(Service as any).extendEnvVars.restore();
		(dockerUtils.getNetworkGateway as sinon.SinonStub).restore();

		// @ts-expect-error Assigning to a RO property
		images.save = originalImagesSave;
		// @ts-expect-error Assigning to a RO property
		images.inspectByName = originalImagesInspect;
		// @ts-expect-error Assigning to a RO property
		deviceConfig.getCurrent = originalGetCurrent;
	});

	beforeEach(async () => {
		await prepare();
	});

	it('loads a target state from an apps.json file and saves it as target state, then returns it', async () => {
		await loadTargetFromFile(process.env.ROOT_MOUNTPOINT + '/apps.json');
		const targetState = await deviceState.getTarget();

		const json = await getTargetJson();

		expect(targetState)
			.to.have.property('local')
			.that.has.property('apps')
			.that.has.property('1234')
			.that.is.an('object');
		const app = targetState.local.apps[1234];
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('services').that.is.an('array').with.length(1);
		expect(app.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.resin.io/superapp/abcdef:latest');
		expect(app.services[0].config)
			.to.have.property('labels')
			.that.has.property('io.balena.something')
			.that.equals('bar');
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('services').that.is.an('array').with.length(1);
		expect(app.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.resin.io/superapp/abcdef:latest');
		expect(app.services[0].config)
			.to.have.property('labels')
			.that.has.property('io.balena.something')
			.that.equals('bar');
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('services').that.is.an('array').with.length(1);
		expect(app.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.resin.io/superapp/abcdef:latest');
		expect(app.services[0].config)
			.to.have.property('labels')
			.that.has.property('io.balena.something')
			.that.equals('bar');
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('services').that.is.an('array').with.length(1);
		expect(app.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.resin.io/superapp/abcdef:latest');
		expect(app.services[0].config)
			.to.have.property('labels')
			.that.has.property('io.balena.something')
			.that.equals('bar');
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('services').that.is.an('array').with.length(1);
		expect(app.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.resin.io/superapp/abcdef:latest');
		expect(app.services[0].config)
			.to.have.property('labels')
			.that.has.property('io.balena.something')
			.that.equals('bar');
	});

	it('stores info for pinning a device after loading an apps.json with a pinDevice field', async () => {
		await loadTargetFromFile(process.env.ROOT_MOUNTPOINT + '/apps-pin.json');

		const pinned = await config.get('pinDevice');
		expect(pinned).to.have.property('app').that.equals(1234);
		expect(pinned).to.have.property('commit').that.equals('abcdef');
	});

	it('emits a change event when a new state is reported', (done) => {
		deviceState.once('change', done);
		deviceState.reportCurrentState({ someStateDiff: 'someValue' } as any);
	});

	it('returns the current state');

	it.skip('writes the target state to the db with some extra defaults', async () => {
		const testTarget = _.cloneDeep(testTargetWithDefaults2);

		const services: Service[] = [];
		for (const service of testTarget.local.apps['1234'].services) {
			const imageName = await images.normalise(service.image);
			service.image = imageName;
			(service as any).imageName = imageName;
			services.push(
				Service.fromComposeObject(service, { appName: 'supertest' } as any),
			);
		}

		(testTarget as any).local.apps['1234'].services = _.keyBy(
			services,
			'serviceId',
		);
		(testTarget as any).local.apps['1234'].source = source;
		await deviceState.setTarget(testTarget2);
		const target = await deviceState.getTarget();
		expect(JSON.parse(JSON.stringify(target))).to.deep.equal(
			JSON.parse(JSON.stringify(testTarget)),
		);
	});

	it('does not allow setting an invalid target state', () => {
		expect(deviceState.setTarget(testTargetInvalid as any)).to.be.rejected;
	});

	it('allows triggering applying the target state', (done) => {
		const applyTargetStub = stub(deviceState, 'applyTarget').returns(
			Promise.resolve(),
		);

		deviceState.triggerApplyTarget({ force: true });
		expect(applyTargetStub).to.not.be.called;

		setTimeout(() => {
			expect(applyTargetStub).to.be.calledWith({
				force: true,
				initial: false,
			});
			applyTargetStub.restore();
			done();
		}, 1000);
	});

	// TODO: There is no easy way to test this behaviour with the current
	// interface of device-state. We should really think about the device-state
	// interface to allow this flexibility (and to avoid having to change module
	// internal variables)
	it.skip('cancels current promise applying the target state');

	it.skip('applies the target state for device config');

	it.skip('applies the target state for applications');

	describe('healthchecks', () => {
		let configStub: SinonStub;
		let infoLobSpy: SinonSpy;

		beforeEach(() => {
			// This configStub will be modified in each test case so we can
			// create the exact conditions we want to for testing healthchecks
			configStub = stub(config, 'get');
			infoLobSpy = spy(Log, 'info');
		});

		afterEach(() => {
			configStub.restore();
			infoLobSpy.restore();
		});

		// it.skip('passes with correct conditions', async () => {
		// 	// Setup passing condition
		// 	const previousValue = deviceState.__get__('applyInProgress');
		// 	deviceState.__set__('applyInProgress', false);

		// 	// const previousValue = deviceState.applyInProgress;
		// 	// deviceState.applyInProgress = false;

		// 	expect(await deviceState.healthcheck()).to.equal(true);

		// 	// Restore value
		// 	deviceState.__set__('applyInProgress', previousValue);
		// 	// deviceState.applyInProgress = previousValue;
		// });

		// it.skip('passes if unmanaged is true and exit early', async () => {
		// 	// Setup failing conditions
		// 	const previousPollTime = deviceState.__get__('maxPollTime');
		// 	const previousValue = deviceState.__get__('applyInProgress');
		// 	deviceState.__set__('applyInProgress', true);
		// 	deviceState.__set__('maxPollTime', 1);
		// 	// Verify this causes healthcheck to fail
		// 	expect(await deviceState.healthcheck()).to.equal(false);
		// 	// Do it again but set unmanaged to true
		// 	configStub.resolves({
		// 		unmanaged: true,
		// 	});
		// 	expect(await deviceState.healthcheck()).to.equal(true);
		// 	// Restore value
		// 	deviceState.__set__('applyInProgress', previousValue);
		// 	deviceState.__set__('maxPollTime', previousPollTime);
		// });

		// it.skip('fails when applyTargetHealthy is false', async () => {
		// 	// Copy previous values to restore later
		// 	const previousValue = deviceState.__get__('applyInProgress');
		// 	const previousPollTime = deviceState.__get__('maxPollTime');
		// 	// Setup failing conditions
		// 	deviceState.__set__('applyInProgress', true);
		// 	deviceState.__set__('maxPollTime', 1);
		// 	expect(await deviceState.healthcheck()).to.equal(false);
		// 	expect(Log.info).to.be.calledOnce;
		// 	expect((Log.info as SinonSpy).lastCall?.lastArg).to.equal(
		// 		stripIndent`
		// 		Healthcheck failure - Atleast ONE of the following conditions must be true:
		// 			- No applyInProgress      ? false
		// 			- fetchesInProgress       ? false
		// 			- cycleTimeWithinInterval ? false`,
		// 	);
		// 	// Restore value
		// 	deviceState.__set__('applyInProgress', previousValue);
		// 	deviceState.__set__('maxPollTime', previousPollTime);
		// });
	});
});
