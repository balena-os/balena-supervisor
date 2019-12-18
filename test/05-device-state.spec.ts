import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { stub } from 'sinon';

import chai = require('./lib/chai-config');
import prepare = require('./lib/prepare');
// tslint:disable-next-line
chai.use(require('chai-events'));

const { expect } = chai;

import Config from '../src/config';
import { RPiConfigBackend } from '../src/config/backend';
import DB from '../src/db';
import DeviceState from '../src/device-state';

import { loadTargetFromFile } from '../src/device-state/preload';

import Service from '../src/compose/service';

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
				services: [
					{
						appId: 1234,
						serviceId: 23,
						imageId: 12345,
						serviceName: 'someservice',
						releaseId: 1,
						image: 'registry2.resin.io/superapp/abcdef:latest',
						labels: {
							'io.resin.something': 'bar',
						},
					},
				],
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
		apps: [
			{
				appId: '1234',
				name: 'superapp',
				commit: 'afafafa',
				releaseId: '2',
				config: {},
				services: [
					{
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
					{
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
				],
			},
		],
	},
	dependent: { apps: [], devices: [] },
};

describe('deviceState', () => {
	const db = new DB();
	const config = new Config({ db });
	const logger = {
		clearOutOfDateDBLogs() {
			/* noop */
		},
	};
	let deviceState: DeviceState;
	before(async () => {
		prepare();
		const eventTracker = {
			track: console.log,
		};

		stub(Service as any, 'extendEnvVars').callsFake(env => {
			env['ADDITIONAL_ENV_VAR'] = 'foo';
			return env;
		});

		deviceState = new DeviceState({
			db,
			config,
			eventTracker: eventTracker as any,
			logger: logger as any,
		});

		stub(deviceState.applications.docker, 'getNetworkGateway').returns(
			Promise.resolve('172.17.0.1'),
		);

		stub(deviceState.applications.images, 'inspectByName').callsFake(() => {
			const err: any = new Error();
			err.statusCode = 404;
			return Promise.reject(err);
		});

		(deviceState as any).deviceConfig.configBackend = new RPiConfigBackend();
		await db.init();
		await config.init();
	});

	after(() => {
		(Service as any).extendEnvVars.restore();
		(deviceState.applications.docker
			.getNetworkGateway as sinon.SinonStub).restore();
		(deviceState.applications.images
			.inspectByName as sinon.SinonStub).restore();
	});

	it('loads a target state from an apps.json file and saves it as target state, then returns it', async () => {
		stub(deviceState.applications.images, 'save').returns(Promise.resolve());
		stub(deviceState.deviceConfig, 'getCurrent').returns(
			Promise.resolve(mockedInitialConfig),
		);

		try {
			await loadTargetFromFile(
				process.env.ROOT_MOUNTPOINT + '/apps.json',
				deviceState,
			);
			const targetState = await deviceState.getTarget();

			const testTarget = _.cloneDeep(testTarget1);
			testTarget.local.apps['1234'].services = _.map(
				testTarget.local.apps['1234'].services,
				(s: any) => {
					s.imageName = s.image;
					return Service.fromComposeObject(s, { appName: 'superapp' } as any);
				},
			) as any;

			expect(JSON.parse(JSON.stringify(targetState))).to.deep.equal(
				JSON.parse(JSON.stringify(testTarget)),
			);
		} finally {
			(deviceState.applications.images.save as sinon.SinonStub).restore();
			(deviceState.deviceConfig.getCurrent as sinon.SinonStub).restore();
		}
	});

	it('stores info for pinning a device after loading an apps.json with a pinDevice field', () => {
		stub(deviceState.applications.images, 'save').returns(Promise.resolve());
		stub(deviceState.deviceConfig, 'getCurrent').returns(
			Promise.resolve(mockedInitialConfig),
		);
		loadTargetFromFile(
			process.env.ROOT_MOUNTPOINT + '/apps-pin.json',
			deviceState,
		).then(() => {
			(deviceState as any).applications.images.save.restore();
			(deviceState as any).deviceConfig.getCurrent.restore();

			config.get('pinDevice').then(pinned => {
				expect(pinned)
					.to.have.property('app')
					.that.equals(1234);
				expect(pinned)
					.to.have.property('commit')
					.that.equals('abcdef');
			});
		});
	});

	it('emits a change event when a new state is reported', () => {
		deviceState.reportCurrentState({ someStateDiff: 'someValue' } as any);
		return (expect as any)(deviceState).to.emit('change');
	});

	it('returns the current state');

	it('writes the target state to the db with some extra defaults', async () => {
		const testTarget = _.cloneDeep(testTargetWithDefaults2);

		const services: Service[] = [];
		for (const service of testTarget.local.apps['1234'].services) {
			const imageName = await (deviceState.applications
				.images as any).normalise(service.image);
			service.image = imageName;
			(service as any).imageName = imageName;
			services.push(
				Service.fromComposeObject(service, { appName: 'supertest' } as any),
			);
		}

		(testTarget as any).local.apps['1234'].services = services;
		await deviceState.setTarget(testTarget2);
		const target = await deviceState.getTarget();
		expect(JSON.parse(JSON.stringify(target))).to.deep.equal(
			JSON.parse(JSON.stringify(testTarget)),
		);
	});

	it('does not allow setting an invalid target state', () => {
		expect(deviceState.setTarget(testTargetInvalid as any)).to.be.rejected;
	});

	it('allows triggering applying the target state', done => {
		stub(deviceState as any, 'applyTarget').returns(Promise.resolve());

		deviceState.triggerApplyTarget({ force: true });
		expect((deviceState as any).applyTarget).to.not.be.called;

		setTimeout(() => {
			expect((deviceState as any).applyTarget).to.be.calledWith({
				force: true,
				initial: false,
			});
			(deviceState as any).applyTarget.restore();
			done();
		}, 5);
	});

	it('cancels current promise applying the target state', done => {
		(deviceState as any).scheduledApply = { force: false, delay: 100 };
		(deviceState as any).applyInProgress = true;
		(deviceState as any).applyCancelled = false;

		new Bluebird((resolve, reject) => {
			setTimeout(resolve, 100000);
			(deviceState as any).cancelDelay = reject;
		})
			.catch(() => {
				(deviceState as any).applyCancelled = true;
			})
			.finally(() => {
				expect((deviceState as any).scheduledApply).to.deep.equal({
					force: true,
					delay: 0,
				});
				expect((deviceState as any).applyCancelled).to.be.true;
				done();
			});

		deviceState.triggerApplyTarget({ force: true, isFromApi: true });
	});

	it('applies the target state for device config');

	it('applies the target state for applications');
});
