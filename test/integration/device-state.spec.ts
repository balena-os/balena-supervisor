import { expect } from 'chai';
import * as sinon from 'sinon';
import { UpdatesLockedError } from '~/lib/errors';
import * as fsUtils from '~/lib/fs-utils';
import * as updateLock from '~/lib/update-lock';
import * as config from '~/src/config';
import * as deviceState from '~/src/device-state';
import { appsJsonBackup, loadTargetFromFile } from '~/src/device-state/preload';
import type { TargetState } from '~/src/types';
import { promises as fs } from 'fs';
import { initializeContractRequirements } from '~/lib/contracts';

import { testfs } from 'mocha-pod';
import { createDockerImage } from '~/test-lib/docker-helper';
import Docker from 'dockerode';
import { setTimeout } from 'timers/promises';

describe('device-state', () => {
	const docker = new Docker();
	before(async () => {
		await config.initialized();

		// Set the device uuid
		await config.set({ uuid: 'local' });
		initializeContractRequirements({
			supervisorVersion: '11.0.0',
			deviceType: 'intel-nuc',
			deviceArch: 'amd64',
		});
	});

	after(async () => {
		await docker.pruneImages({ filters: { dangling: { false: true } } });
	});

	it('loads a target state from an apps.json file and saves it as target state, then returns it', async () => {
		const localFs = await testfs(
			{ '/data/apps.json': testfs.from('test/data/apps.json') },
			{ cleanup: ['/data/apps.json.preloaded'] },
		).enable();

		// The image needs to exist before the test
		const dockerImageId = await createDockerImage(
			'registry2.resin.io/superapp/abcdef:latest',
			['io.balena.testing=1'],
			docker,
		);

		const appsJson = '/data/apps.json';
		await expect(
			fs.access(appsJson),
			'apps.json exists before loading the target',
		).to.not.be.rejected;
		await loadTargetFromFile(appsJson);
		const targetState = await deviceState.getTarget();
		await expect(
			fs.access(appsJsonBackup(appsJson)),
			'apps.json.preloaded is created after loading the target',
		).to.not.be.rejected;
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
			.that.equals(dockerImageId);
		expect(app.services[0].config)
			.to.have.property('labels')
			.that.has.property('io.balena.something')
			.that.equals('bar');

		// Remove the image
		await docker.getImage(dockerImageId).remove();
		await localFs.restore();
	});

	it('stores info for pinning a device after loading an apps.json with a pinDevice field', async () => {
		const localFs = await testfs(
			{ '/data/apps.json': testfs.from('test/data/apps-pin.json') },
			{ cleanup: ['/data/apps.json.preloaded'] },
		).enable();

		// The image needs to exist before the test
		const dockerImageId = await createDockerImage(
			'registry2.resin.io/superapp/abcdef:latest',
			['io.balena.testing=1'],
			docker,
		);

		const appsJson = '/data/apps.json';
		await loadTargetFromFile(appsJson);

		const pinned = await config.get('pinDevice');
		expect(pinned).to.have.property('app').that.equals(1234);
		expect(pinned).to.have.property('commit').that.equals('abcdef');
		expect(await fsUtils.exists(appsJsonBackup(appsJson))).to.be.true;

		// Remove the image
		await docker.getImage(dockerImageId).remove();
		await localFs.restore();
	});

	it('emits a change event when a new state is reported', (done) => {
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
		return expect(
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
			} as any),
		).to.be.rejected;
	});

	it('allows triggering applying the target state', async () => {
		const applyTargetStub = sinon
			.stub(deviceState, 'applyTarget')
			.returns(Promise.resolve());

		deviceState.triggerApplyTarget({ force: true });
		expect(applyTargetStub).to.not.be.called;

		await setTimeout(1000);
		expect(applyTargetStub).to.be.calledWith({
			force: true,
			initial: false,
		});
		applyTargetStub.restore();
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
		expect(app).to.have.property('isRejected').that.is.false;
		// Only a single service should be on the target state
		expect(app).to.have.property('services').that.is.an('array').with.length(1);
		expect(app.services[0])
			.that.has.property('serviceName')
			.that.equals('valid');
	});

	it('accepts target state with invalid contract setting isRejected to true and resets state when a valid target is received', async () => {
		// Set the rejected target
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
														type: 'arch.sw',
														slug: 'armv7hf',
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
		).to.not.be.rejected;
		const targetState = await deviceState.getTarget();
		const app = targetState.local.apps[1234];
		expect(app).to.have.property('appName').that.equals('superapp');
		expect(app).to.have.property('commit').that.equals('one');
		expect(app).to.have.property('isRejected').that.is.true;

		// Now set a good target for the same app
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
							two: {
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

		const targetState2 = await deviceState.getTarget();
		const app2 = targetState2.local.apps[1234];
		expect(app2).to.have.property('commit').that.equals('two');
		expect(app2).to.have.property('isRejected').that.is.false;
	});

	// Resolves an issue in balenaMachine instances that were installed at <v14.1.0,
	// in which a Supervisor app with random UUID is kept in the target db due to its appId
	// being the same, even after the BM instance has upgraded to v14.1.0 which patches
	// the correct reserved Supervisor app UUIDs in. This results in two Supervisors running
	// on devices under the BM instance which persists after BM upgrade.
	// See: https://balena.fibery.io/search/T7ozi#Inputs/Pattern/Two-supervisors-are-running-on-device-3370
	it('removes apps with UUIDs not in target but where appId are the same as those in target, from target state', async () => {
		const WRONG_UUID = '50e35121417640b1b28a680504e4039a';
		const RIGHT_UUID = '52e35121417640b1b28a680504e4039b';
		const APP_ID = 1667442;
		await deviceState.setTarget({
			local: {
				name: 'trixie',
				config: {},
				apps: {
					// Supervisor has the wrong app UUID initially, but the right appId
					[WRONG_UUID]: {
						id: APP_ID,
						name: 'amd64-supervisor',
						class: 'app',
						releases: {
							deadbeef: {
								id: 1,
								services: {
									'balena-test-supervisor': {
										id: 2,
										image_id: 3,
										image: 'registry2.balena-cloud.com/deadca1f',
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
		expect(targetState)
			.to.have.property('local')
			.that.has.property('apps')
			.that.has.property(APP_ID.toString())
			.that.is.an('object');

		const testSupervisor = targetState.local.apps[APP_ID];
		expect(testSupervisor)
			.to.have.property('appName')
			.that.equals('amd64-supervisor');
		expect(testSupervisor).to.have.property('appUuid').that.equals(WRONG_UUID);
		expect(testSupervisor).to.have.property('commit').that.equals('deadbeef');
		expect(testSupervisor)
			.to.have.property('services')
			.that.is.an('array')
			.with.length(1);
		expect(testSupervisor.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.balena-cloud.com/deadca1f:latest');

		await deviceState.setTarget({
			local: {
				name: 'trixie',
				config: {},
				apps: {
					// Supervisor apps have been patched in user's BM to have
					// the right app UUID, so this is now sent in the target state
					[RIGHT_UUID]: {
						id: APP_ID,
						name: 'amd64-supervisor',
						class: 'app',
						releases: {
							deadbeef: {
								id: 1,
								services: {
									'balena-test-supervisor': {
										id: 2,
										image_id: 3,
										image: 'registry2.balena-cloud.com/deadca1f',
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
		const targetState2 = await deviceState.getTarget();
		expect(targetState2)
			.to.have.property('local')
			.that.has.property('apps')
			.that.has.property(APP_ID.toString())
			.that.is.an('object');

		const testSupervisor2 = targetState2.local.apps[APP_ID];
		expect(testSupervisor2)
			.to.have.property('appName')
			.that.equals('amd64-supervisor');
		// Db apps whose UUIDs aren't in target are removed
		// (As opposed to before, where appIds were compared for removal)
		expect(testSupervisor2).to.have.property('appUuid').that.equals(RIGHT_UUID);
		expect(testSupervisor2).to.have.property('commit').that.equals('deadbeef');
		expect(testSupervisor2)
			.to.have.property('services')
			.that.is.an('array')
			.with.length(1);
		expect(testSupervisor2.services[0])
			.to.have.property('config')
			.that.has.property('image')
			.that.equals('registry2.balena-cloud.com/deadca1f:latest');
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

		await expect(deviceState.shutdown({ reboot: true }))
			.to.eventually.be.rejectedWith(testErrMsg)
			.and.be.an.instanceOf(UpdatesLockedError);
		await expect(deviceState.shutdown())
			.to.eventually.be.rejectedWith(testErrMsg)
			.and.be.an.instanceOf(UpdatesLockedError);

		(updateLock.abortIfHUPInProgress as sinon.SinonStub).restore();
	});
});
