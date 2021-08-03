import { expect } from 'chai';
import * as sinon from 'sinon';

import { StatusCodeError, UpdatesLockedError } from '../src/lib/errors';
import * as dockerUtils from '../src/lib/docker-utils';
import * as config from '../src/config';
import * as imageManager from '../src/compose/images';
import { ConfigTxt } from '../src/config/backends/config-txt';
import * as deviceState from '../src/device-state';
import * as deviceConfig from '../src/device-config';
import {
	loadTargetFromFile,
	appsJsonBackup,
} from '../src/device-state/preload';
import Service from '../src/compose/service';
import { intialiseContractRequirements } from '../src/lib/contracts';
import * as updateLock from '../src/lib/update-lock';
import * as fsUtils from '../src/lib/fs-utils';
import { TargetState } from '../src/types';

import * as dbHelper from './lib/db-helper';
import log from '../src/lib/supervisor-console';

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

describe('device-state', () => {
	const originalImagesSave = imageManager.save;
	const originalImagesInspect = imageManager.inspectByName;
	const originalGetCurrent = deviceConfig.getCurrent;

	let testDb: dbHelper.TestDatabase;

	before(async () => {
		testDb = await dbHelper.createDB();

		await config.initialized;

		// Prevent side effects from changes in config
		sinon.stub(config, 'on');

		// Set the device uuid
		await config.set({ uuid: 'local' });

		await deviceState.initialized;

		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'event');
		sinon.stub(log, 'success');

		// TODO: all these stubs are internal implementation details of
		// deviceState, we should refactor deviceState to use dependency
		// injection instead of initializing everything in memory
		sinon.stub(Service as any, 'extendEnvVars').callsFake((env) => {
			env['ADDITIONAL_ENV_VAR'] = 'foo';
			return env;
		});

		intialiseContractRequirements({
			supervisorVersion: '11.0.0',
			deviceType: 'intel-nuc',
		});

		sinon
			.stub(dockerUtils, 'getNetworkGateway')
			.returns(Promise.resolve('172.17.0.1'));

		// @ts-expect-error Assigning to a RO property
		imageManager.cleanImageData = () => {
			console.log('Cleanup database called');
		};

		// @ts-expect-error Assigning to a RO property
		imageManager.save = () => Promise.resolve();

		// @ts-expect-error Assigning to a RO property
		imageManager.inspectByName = () => {
			const err: StatusCodeError = new Error();
			err.statusCode = 404;
			return Promise.reject(err);
		};

		// @ts-expect-error Assigning to a RO property
		deviceConfig.configBackend = new ConfigTxt();

		// @ts-expect-error Assigning to a RO property
		deviceConfig.getCurrent = async () => mockedInitialConfig;
	});

	after(async () => {
		(Service as any).extendEnvVars.restore();
		(dockerUtils.getNetworkGateway as sinon.SinonStub).restore();

		// @ts-expect-error Assigning to a RO property
		imageManager.save = originalImagesSave;
		// @ts-expect-error Assigning to a RO property
		imageManager.inspectByName = originalImagesInspect;
		// @ts-expect-error Assigning to a RO property
		deviceConfig.getCurrent = originalGetCurrent;

		try {
			await testDb.destroy();
		} catch (e) {
			/* noop */
		}
		sinon.restore();
	});

	afterEach(async () => {
		await testDb.reset();
	});

	it('loads a target state from an apps.json file and saves it as target state, then returns it', async () => {
		const appsJson = process.env.ROOT_MOUNTPOINT + '/apps.json';
		await loadTargetFromFile(appsJson);
		const targetState = await deviceState.getTarget();
		expect(await fsUtils.exists(appsJsonBackup(appsJson))).to.be.true;

		expect(targetState)
			.to.have.property('local')
			.that.has.property('config')
			.that.has.property('HOST_CONFIG_gpu_mem')
			.that.equals('256');
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

		// Restore renamed apps.json
		await fsUtils.safeRename(appsJsonBackup(appsJson), appsJson);
	});

	it('stores info for pinning a device after loading an apps.json with a pinDevice field', async () => {
		const appsJson = process.env.ROOT_MOUNTPOINT + '/apps-pin.json';
		await loadTargetFromFile(appsJson);

		const pinned = await config.get('pinDevice');
		expect(pinned).to.have.property('app').that.equals(1234);
		expect(pinned).to.have.property('commit').that.equals('abcdef');
		expect(await fsUtils.exists(appsJsonBackup(appsJson))).to.be.true;

		// Restore renamed apps.json
		await fsUtils.safeRename(appsJsonBackup(appsJson), appsJson);
	});

	it('emits a change event when a new state is reported', (done) => {
		// TODO: where is the test on this test?
		deviceState.once('change', done);
		deviceState.reportCurrentState({ someStateDiff: 'someValue' } as any);
	});

	it('writes the target state to the db with some extra defaults', async () => {
		await deviceState.setTarget({
			local: {
				name: 'aDeviceWithDifferentName',
				config: {
					RESIN_HOST_CONFIG_gpu_mem: '512',
				},
				apps: {
					myapp: {
						id: 1234,
						name: 'superapp',
						class: 'fleet',
						releases: {
							afafafa: {
								id: 2,
								services: {
									aservice: {
										id: 23,
										image_id: 12345,
										image: 'registry2.resin.io/superapp/edfabc',
										environment: {
											FOO: 'bar',
										},
										labels: {},
									},
									anotherService: {
										id: 24,
										image_id: 12346,
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
				},
			},
		} as TargetState);
		const targetState = await deviceState.getTarget();

		expect(targetState)
			.to.have.property('local')
			.that.has.property('config')
			.that.has.property('HOST_CONFIG_gpu_mem')
			.that.equals('512');

		expect(targetState)
			.to.have.property('local')
			.that.has.property('apps')
			.that.has.property('1234')
			.that.is.an('object');

		const app = targetState.local.apps[1234];
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('commit').that.equals('afafafa');
		expect(app).to.have.property('services').that.is.an('array').with.length(2);
		expect(app.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.resin.io/superapp/edfabc:latest');
		expect(app.services[0].config)
			.to.have.property('environment')
			.that.has.property('FOO')
			.that.equals('bar');
		expect(app.services[1])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.resin.io/superapp/afaff:latest');
		expect(app.services[1].config)
			.to.have.property('environment')
			.that.has.property('FOO')
			.that.equals('bro');
	});

	it('does not allow setting an invalid target state', () => {
		// v2 state should be rejected
		expect(
			deviceState.setTarget({
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
									environment: {
										FOO: 'bro',
									},
									labels: {},
								},
							},
						},
					},
				},
				dependent: { apps: {}, devices: {} },
			} as any),
		).to.be.rejected;
	});

	it('allows triggering applying the target state', (done) => {
		const applyTargetStub = sinon
			.stub(deviceState, 'applyTarget')
			.returns(Promise.resolve());

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

	it('accepts a target state with an valid contract', async () => {
		await deviceState.setTarget({
			local: {
				name: 'aDeviceWithDifferentName',
				config: {},
				apps: {
					myapp: {
						id: 1234,
						name: 'superapp',
						class: 'fleet',
						releases: {
							one: {
								id: 2,
								services: {
									valid: {
										id: 23,
										image_id: 12345,
										image: 'registry2.resin.io/superapp/valid',
										environment: {},
										labels: {},
									},
									alsoValid: {
										id: 24,
										image_id: 12346,
										image: 'registry2.resin.io/superapp/afaff',
										contract: {
											type: 'sw.container',
											slug: 'supervisor-version',
											name: 'Enforce supervisor version',
											requires: [
												{
													type: 'sw.supervisor',
													version: '>=11.0.0',
												},
											],
										},
										environment: {},
										labels: {},
									},
								},
								volumes: {},
								networks: {},
							},
						},
					},
				},
			},
		} as TargetState);
		const targetState = await deviceState.getTarget();
		const app = targetState.local.apps[1234];
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('commit').that.equals('one');
		// Only a single service should be on the target state
		expect(app).to.have.property('services').that.is.an('array').with.length(2);
		expect(app.services[1])
			.that.has.property('serviceName')
			.that.equals('alsoValid');
	});

	it('accepts a target state with an invalid contract for an optional container', async () => {
		await deviceState.setTarget({
			local: {
				name: 'aDeviceWithDifferentName',
				config: {},
				apps: {
					myapp: {
						id: 1234,
						name: 'superapp',
						class: 'fleet',
						releases: {
							one: {
								id: 2,
								services: {
									valid: {
										id: 23,
										image_id: 12345,
										image: 'registry2.resin.io/superapp/valid',
										environment: {},
										labels: {},
									},
									invalidButOptional: {
										id: 24,
										image_id: 12346,
										image: 'registry2.resin.io/superapp/afaff',
										contract: {
											type: 'sw.container',
											slug: 'supervisor-version',
											name: 'Enforce supervisor version',
											requires: [
												{
													type: 'sw.supervisor',
													version: '>=12.0.0',
												},
											],
										},
										environment: {},
										labels: {
											'io.balena.features.optional': 'true',
										},
									},
								},
								volumes: {},
								networks: {},
							},
						},
					},
				},
			},
		} as TargetState);
		const targetState = await deviceState.getTarget();
		const app = targetState.local.apps[1234];
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('commit').that.equals('one');
		// Only a single service should be on the target state
		expect(app).to.have.property('services').that.is.an('array').with.length(1);
		expect(app.services[0])
			.that.has.property('serviceName')
			.that.equals('valid');
	});

	it('rejects a target state with invalid contract and non optional service', async () => {
		await expect(
			deviceState.setTarget({
				local: {
					name: 'aDeviceWithDifferentName',
					config: {},
					apps: {
						myapp: {
							id: 1234,
							name: 'superapp',
							class: 'fleet',
							releases: {
								one: {
									id: 2,
									services: {
										valid: {
											id: 23,
											image_id: 12345,
											image: 'registry2.resin.io/superapp/valid',
											environment: {},
											labels: {},
										},
										invalid: {
											id: 24,
											image_id: 12346,
											image: 'registry2.resin.io/superapp/afaff',
											contract: {
												type: 'sw.container',
												slug: 'supervisor-version',
												name: 'Enforce supervisor version',
												requires: [
													{
														type: 'sw.supervisor',
														version: '>=12.0.0',
													},
												],
											},
											environment: {},
											labels: {},
										},
									},
									volumes: {},
									networks: {},
								},
							},
						},
					},
				},
			} as TargetState),
		).to.be.rejected;
	});

	// TODO: There is no easy way to test this behaviour with the current
	// interface of device-state. We should really think about the device-state
	// interface to allow this flexibility (and to avoid having to change module
	// internal variables)
	it.skip('cancels current promise applying the target state');

	it.skip('applies the target state for device config');

	it.skip('applies the target state for applications');

	it('prevents reboot or shutdown when HUP rollback breadcrumbs are present', async () => {
		const testErrMsg = 'Waiting for Host OS updates to finish';
		sinon
			.stub(updateLock, 'abortIfHUPInProgress')
			.throws(new UpdatesLockedError(testErrMsg));

		await expect(deviceState.reboot())
			.to.eventually.be.rejectedWith(testErrMsg)
			.and.be.an.instanceOf(UpdatesLockedError);
		await expect(deviceState.shutdown())
			.to.eventually.be.rejectedWith(testErrMsg)
			.and.be.an.instanceOf(UpdatesLockedError);

		(updateLock.abortIfHUPInProgress as sinon.SinonStub).restore();
	});
});
