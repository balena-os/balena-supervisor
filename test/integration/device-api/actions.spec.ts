import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import Docker from 'dockerode';
import request from 'supertest';
import { setTimeout } from 'timers/promises';
import { testfs } from 'mocha-pod';
import * as fs from 'fs/promises';

import * as deviceState from '~/src/device-state';
import * as config from '~/src/config';
import * as hostConfig from '~/src/host-config';
import * as deviceApi from '~/src/device-api';
import * as actions from '~/src/device-api/actions';
import * as TargetState from '~/src/device-state/target-state';
import * as updateLock from '~/lib/update-lock';
import { pathOnRoot } from '~/lib/host-utils';
import { exec, touch } from '~/lib/fs-utils';
import { cleanupDocker } from '~/test-lib/docker-helper';

export async function dbusSend(
	dest: string,
	path: string,
	message: string,
	...contents: string[]
) {
	const { stdout, stderr } = await exec(
		[
			'dbus-send',
			'--system',
			`--dest=${dest}`,
			'--print-reply',
			path,
			message,
			...contents,
		].join(' '),
		{ encoding: 'utf8' },
	);

	if (stderr) {
		throw new Error(stderr);
	}

	// Remove first line, trim each line, and join them back together
	return stdout
		.split(/\r?\n/)
		.slice(1)
		.map((s) => s.trim())
		.join('');
}

describe('regenerates API keys', () => {
	// Stub external dependency - current state report should be tested separately.
	// API key related methods are tested in api-keys.spec.ts.
	beforeEach(() => stub(deviceState, 'reportCurrentState'));
	afterEach(() => (deviceState.reportCurrentState as SinonStub).restore());

	it("communicates new key to cloud if it's a global key", async () => {
		const originalGlobalKey = await deviceApi.getGlobalApiKey();
		const newKey = await actions.regenerateKey(originalGlobalKey);
		expect(originalGlobalKey).to.not.equal(newKey);
		expect(newKey).to.equal(await deviceApi.getGlobalApiKey());
		expect(deviceState.reportCurrentState as SinonStub).to.have.been.calledOnce;
		expect(
			(deviceState.reportCurrentState as SinonStub).firstCall.args[0],
		).to.deep.equal({
			api_secret: newKey,
		});
	});

	it("doesn't communicate new key if it's a service key", async () => {
		const originalScopedKey = await deviceApi.generateScopedKey(111, 'main');
		const newKey = await actions.regenerateKey(originalScopedKey);
		expect(originalScopedKey).to.not.equal(newKey);
		expect(newKey).to.not.equal(await deviceApi.getGlobalApiKey());
		expect(deviceState.reportCurrentState as SinonStub).to.not.have.been.called;
	});
});

describe('manages application lifecycle', () => {
	const BASE_IMAGE = 'alpine:latest';
	const BALENA_SUPERVISOR_ADDRESS =
		process.env.BALENA_SUPERVISOR_ADDRESS || 'http://balena-supervisor:48484';
	const APP_ID = 1;
	const lockdir = pathOnRoot(updateLock.BASE_LOCK_DIR);
	const docker = new Docker();

	const getSupervisorTarget = async () =>
		await request(BALENA_SUPERVISOR_ADDRESS)
			.get('/v2/local/target-state')
			.expect(200)
			.then(({ body }) => body.state.local);

	const setSupervisorTarget = async (
		target: Awaited<ReturnType<typeof generateTarget>>,
	) =>
		await request(BALENA_SUPERVISOR_ADDRESS)
			.post('/v2/local/target-state')
			.set('Content-Type', 'application/json')
			.send(JSON.stringify(target))
			.expect(200);

	const generateTargetApps = ({
		serviceCount,
		appId,
		serviceNames,
	}: {
		serviceCount: number;
		appId: number;
		serviceNames: string[];
	}) => {
		// Populate app services
		const services: Dictionary<any> = {};
		for (let i = 1; i <= serviceCount; i++) {
			services[i] = {
				environment: {},
				image: BASE_IMAGE,
				imageId: `${i}`,
				labels: {
					'io.balena.testing': '1',
				},
				restart: 'unless-stopped',
				running: true,
				serviceName: serviceNames[i - 1],
				serviceId: `${i}`,
				volumes: ['data:/data'],
				command: 'sleep infinity',
				// Kill container immediately instead of waiting for 10s
				stop_signal: 'SIGKILL',
			};
		}

		return {
			[appId]: {
				name: 'localapp',
				commit: 'localcommit',
				releaseId: '1',
				services,
				volumes: {
					data: {},
				},
			},
		};
	};

	const generateTarget = async ({
		serviceCount,
		appId = APP_ID,
		serviceNames = ['server', 'client'],
	}: {
		serviceCount: number;
		appId?: number;
		serviceNames?: string[];
	}) => {
		const { name, config: svConfig } = await getSupervisorTarget();
		return {
			local: {
				// We don't want to change name or config as this may result in
				// unintended reboots. We just want to test state changes in containers.
				name,
				config: svConfig,
				apps:
					serviceCount === 0
						? {}
						: generateTargetApps({
								serviceCount,
								appId,
								serviceNames,
							}),
			},
		};
	};

	const isAllRunning = (ctns: Docker.ContainerInspectInfo[]) =>
		ctns.every((ctn) => ctn.State.Running);

	const isAllExited = (ctns: Docker.ContainerInspectInfo[]) =>
		ctns.every((ctn) => !ctn.State.Running);

	const isSomeExited = (ctns: Docker.ContainerInspectInfo[]) =>
		ctns.some((ctn) => !ctn.State.Running);

	// Wait until containers are in a ready state prior to testing assertions
	const waitForSetup = async (
		targetState: Dictionary<any>,
		isWaitComplete: (
			ctns: Docker.ContainerInspectInfo[],
		) => boolean = isAllRunning,
	) => {
		// Get expected number of containers from target state
		const expected = Object.keys(
			targetState.local.apps[`${APP_ID}`].services,
		).length;

		// Wait for engine until number of containers are reached.
		// This test suite will timeout if anything goes wrong, since
		// we don't have any way of knowing whether Docker has finished
		// setting up containers or not.
		let containers = await docker.listContainers({ all: true });
		let containerInspects = await Promise.all(
			containers.map(({ Id }) => docker.getContainer(Id).inspect()),
		);
		while (
			expected !== containers.length ||
			!isWaitComplete(containerInspects)
		) {
			await setTimeout(500);
			containers = await docker.listContainers({ all: true });
			containerInspects = await Promise.all(
				containers.map(({ Id }) => docker.getContainer(Id).inspect()),
			);
		}
		return containerInspects;
	};

	// Get NEW container inspects. This function should be passed to waitForSetup
	// when checking a container has started or been recreated. This is necessary
	// because waitForSetup may erroneously return the existing 2 containers
	// in its while loop if stopping them takes some time.
	const startTimesChanged = (startedAt: string[]) => {
		return (ctns: Docker.ContainerInspectInfo[]) =>
			ctns.every(({ State }) => !startedAt.includes(State.StartedAt));
	};

	const mockFs = testfs(
		{ [`${lockdir}/${APP_ID}`]: {} },
		{ cleanup: [`${lockdir}/${APP_ID}/**/*.lock`] },
	);

	before(async () => {
		// Images are ignored in local mode so we need to pull the base image
		await docker.pull(BASE_IMAGE);
		// Wait for base image to finish pulling
		let images = await docker.listImages();
		while (images.length === 0) {
			await setTimeout(500);
			images = await docker.listImages();
		}
	});

	after(async () => {
		// Reset Supervisor to state from before lifecycle tests
		await setSupervisorTarget(await generateTarget({ serviceCount: 0 }));

		// Remove any leftover engine artifacts
		await cleanupDocker(docker);
	});

	describe('manages single container application lifecycle', () => {
		const serviceCount = 1;
		const serviceNames = ['server'];
		let targetState: Awaited<ReturnType<typeof generateTarget>>;
		let containers: Docker.ContainerInspectInfo[];

		before(async () => {
			targetState = await generateTarget({
				serviceCount,
				serviceNames,
			});
		});

		beforeEach(async () => {
			await mockFs.enable();

			// Create a single-container application in local mode
			await setSupervisorTarget(targetState);
		});

		afterEach(async () => {
			await mockFs.restore();
		});

		// Make sure the app is running and correct before testing more assertions
		it('should setup a single container app (sanity check)', async () => {
			containers = await waitForSetup(targetState);
			// Containers should have correct metadata;
			// Testing their names should be sufficient.
			containers.forEach((ctn) => {
				expect(serviceNames.some((name) => new RegExp(name).test(ctn.Name))).to
					.be.true;
			});
		});

		it('should restart an application by recreating containers', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers.map((ctn) => ctn.State.StartedAt),
			);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post(`/v1/restart`)
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ appId: APP_ID }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);
		});

		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should not restart an application when user locks are present', async () => {
			containers = await waitForSetup(targetState);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post(`/v1/restart`)
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ appId: APP_ID }))
				.expect(423);

			// Containers should not have been restarted
			const containersAfterRestart = await waitForSetup(targetState);
			expect(
				containersAfterRestart.map((ctn) => ctn.State.StartedAt),
			).to.deep.include.members(containers.map((ctn) => ctn.State.StartedAt));

			// Remove the lock
			await fs.rm(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);
		});

		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should restart an application when user locks are present if force is specified', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers.map((ctn) => ctn.State.StartedAt),
			);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post(`/v1/restart`)
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ appId: APP_ID, force: true }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Wait briefly for state to settle which includes releasing locks
			await setTimeout(500);

			// User lock should be overridden
			expect(
				await fs.readdir(`${lockdir}/${APP_ID}/${serviceNames[0]}`),
			).to.deep.equal([]);
		});

		it('should restart service by removing and recreating corresponding container', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers.map((ctn) => ctn.State.StartedAt),
			);

			// Calling actions.executeServiceAction directly doesn't work
			// because it relies on querying target state of the balena-supervisor
			// container, which isn't accessible directly from sut.
			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/restart-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0] }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);
		});

		// Since restart-service follows the same code paths as start|stop-service,
		// these lock test cases should be sufficient to cover all three service actions.
		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should not restart service when user locks are present', async () => {
			containers = await waitForSetup(targetState);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/restart-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0] }))
				.expect(423);

			// Containers should not have been restarted
			const containersAfterRestart = await waitForSetup(targetState);
			expect(
				containersAfterRestart.map((ctn) => ctn.State.StartedAt),
			).to.deep.include.members(containers.map((ctn) => ctn.State.StartedAt));

			// Remove the lock
			await fs.rm(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);
		});

		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should restart service when user locks are present if force is specified', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers
					.filter((ctn) => ctn.Name.includes(serviceNames[0]))
					.map((ctn) => ctn.State.StartedAt),
			);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/restart-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0], force: true }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Wait briefly for state to settle which includes releasing locks
			await setTimeout(500);

			// User lock should be overridden
			expect(
				await fs.readdir(`${lockdir}/${APP_ID}/${serviceNames[0]}`),
			).to.deep.equal([]);
		});

		it('should stop a running service', async () => {
			containers = await waitForSetup(targetState);

			// Calling actions.executeServiceAction directly doesn't work
			// because it relies on querying target state of the balena-supervisor
			// container, which isn't accessible directly from sut.
			const response = await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v1/apps/1/stop')
				.set('Content-Type', 'application/json');

			const stoppedContainers = await waitForSetup(targetState, isAllExited);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isAllExited(stoppedContainers)).to.be.true;

			// Containers should have the same Ids since none should be removed
			expect(stoppedContainers.map(({ Id }) => Id)).to.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Endpoint should return the containerId of the stopped service
			expect(response.body).to.deep.equal({
				containerId: stoppedContainers[0].Id,
			});

			// Start the container
			const containerToStart = containers.find(({ Name }) =>
				new RegExp(serviceNames[0]).test(Name),
			);
			if (!containerToStart) {
				expect.fail(
					`Expected a container matching "${serviceNames[0]}" to be present`,
				);
			}
			await docker.getContainer(containerToStart.Id).start();
		});

		it('should start a stopped service', async () => {
			containers = await waitForSetup(targetState);

			// First, stop the container so we can test the start step
			const containerToStop = containers.find((ctn) =>
				new RegExp(serviceNames[0]).test(ctn.Name),
			);
			if (!containerToStop) {
				expect.fail(
					`Expected a container matching "${serviceNames[0]}" to be present`,
				);
			}
			await docker.getContainer(containerToStop.Id).stop();

			// Calling actions.executeServiceAction directly doesn't work
			// because it relies on querying target state of the balena-supervisor
			// container, which isn't accessible directly from sut.
			const response = await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v1/apps/1/start')
				.set('Content-Type', 'application/json');

			const runningContainers = await waitForSetup(targetState, isAllRunning);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isAllRunning(runningContainers)).to.be.true;

			// Containers should have the same Ids since none should be removed
			expect(runningContainers.map(({ Id }) => Id)).to.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Endpoint should return the containerId of the started service
			expect(response.body).to.deep.equal({
				containerId: runningContainers[0].Id,
			});
		});

		it('should return information about a single-container app', async () => {
			containers = await waitForSetup(targetState);
			const containerId = containers[0].Id;
			const imageHash = containers[0].Config.Image;

			// Calling actions.getSingleContainerApp doesn't work because
			// the action queries the database
			const { body } = await request(BALENA_SUPERVISOR_ADDRESS).get(
				'/v1/apps/1',
			);

			expect(body).to.have.property('appId', APP_ID);
			expect(body).to.have.property('containerId', containerId);
			expect(body).to.have.property('imageId', imageHash);
			expect(body).to.have.property('releaseId', 1);
			// Should return the environment of the single service
			expect(body.env).to.have.property('BALENA_APP_ID', String(APP_ID));
			expect(body.env).to.have.property('BALENA_SERVICE_NAME', serviceNames[0]);
		});

		it('should return legacy information about device state', async () => {
			containers = await waitForSetup(targetState);

			const { body } = await request(BALENA_SUPERVISOR_ADDRESS).get(
				'/v1/device',
			);

			expect(body).to.have.property('api_port', 48484);
			// Versions match semver versioning scheme: major.minor.patch(+rev)?
			expect(body)
				.to.have.property('os_version')
				.that.matches(/balenaOS\s[1-4]\.[0-9]{1,3}\.[0-9]{1,3}(?:\+rev[0-9])?/);
			expect(body)
				.to.have.property('supervisor_version')
				.that.matches(/(?:[0-9]+\.?){3}/);
			// Matches a space-separated string of IPv4 and/or IPv6 addresses
			expect(body)
				.to.have.property('ip_address')
				.that.matches(
					/(?:(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3})|(?:(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}))\s?/,
				);
			// Matches a space-separated string of MAC addresses
			expect(body)
				.to.have.property('mac_address')
				.that.matches(/(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\s?/);
			expect(body).to.have.property('update_pending').that.is.a('boolean');
			expect(body).to.have.property('update_failed').that.is.a('boolean');
			expect(body).to.have.property('update_downloaded').that.is.a('boolean');
			// Container should be running so the overall status is Idle
			expect(body).to.have.property('status', 'Idle');
			expect(body).to.have.property('download_progress', null);
		});

		// This test should be ordered last in this `describe` block, because the test compares
		// the `CreatedAt` timestamps of volumes to determine whether purge was successful. Thus,
		// ordering the assertion last will ensure some time has passed between the first `CreatedAt`
		// and the `CreatedAt` extracted from the new volume to pass this assertion.
		it('should purge an application by removing services then removing volumes', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers.map((ctn) => ctn.State.StartedAt),
			);

			// Get volume metadata. As the name stays the same, we just need to check that the volume
			// has been deleted & recreated. We can use the CreatedAt timestamp to determine this.
			const volume = (await docker.listVolumes()).Volumes.find((vol) =>
				/data/.test(vol.Name),
			);
			if (!volume) {
				expect.fail('Expected initial volume with name matching "data"');
			}
			// CreatedAt is a valid key but isn't typed properly
			const createdAt = (volume as any).CreatedAt;

			// Calling actions.doPurge won't work as intended because purge relies on
			// setting and applying intermediate state before applying target state again,
			// but target state is set in the balena-supervisor container instead of sut.
			// NOTE: if running ONLY this test, it has a chance of failing since the first and
			// second volume creation happen in quick succession (sometimes in the same second).
			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v1/purge')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ appId: 1 }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Volume should be recreated
			const newVolume = (await docker.listVolumes()).Volumes.find((vol) =>
				/data/.test(vol.Name),
			);
			if (!volume) {
				expect.fail('Expected recreated volume with name matching "data"');
			}
			expect((newVolume as any).CreatedAt).to.not.equal(createdAt);
		});
	});

	describe('manages multi-container application lifecycle', () => {
		const serviceCount = 2;
		const serviceNames = ['server', 'client'];
		let targetState: Awaited<ReturnType<typeof generateTarget>>;
		let containers: Docker.ContainerInspectInfo[];

		before(async () => {
			targetState = await generateTarget({
				serviceCount,
				serviceNames,
			});
		});

		beforeEach(async () => {
			await mockFs.enable();
			// Create a multi-container application in local mode
			await setSupervisorTarget(targetState);
		});

		afterEach(async () => {
			await mockFs.restore();
		});

		// Make sure the app is running and correct before testing more assertions
		it('should setup a multi-container app (sanity check)', async () => {
			containers = await waitForSetup(targetState);
			// Containers should have correct metadata;
			// Testing their names should be sufficient.
			containers.forEach((ctn) => {
				expect(serviceNames.some((name) => new RegExp(name).test(ctn.Name))).to
					.be.true;
			});
		});

		it('should restart an application by recreating containers', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers.map((ctn) => ctn.State.StartedAt),
			);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post(`/v2/applications/${APP_ID}/restart`)
				.set('Content-Type', 'application/json');

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);
		});

		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should not restart an application when user locks are present', async () => {
			containers = await waitForSetup(targetState);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post(`/v1/restart`)
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ appId: APP_ID }))
				.expect(423);

			// Containers should not have been restarted
			const containersAfterRestart = await waitForSetup(targetState);
			expect(
				containersAfterRestart.map((ctn) => ctn.State.StartedAt),
			).to.deep.include.members(containers.map((ctn) => ctn.State.StartedAt));

			// Remove the lock
			await fs.rm(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);
		});

		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should restart an application when user locks are present if force is specified', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers.map((ctn) => ctn.State.StartedAt),
			);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post(`/v1/restart`)
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ appId: APP_ID, force: true }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Wait briefly for state to settle which includes releasing locks
			await setTimeout(500);

			// User lock should be overridden
			expect(
				await fs.readdir(`${lockdir}/${APP_ID}/${serviceNames[0]}`),
			).to.deep.equal([]);
		});

		it('should restart service by removing and recreating corresponding container', async () => {
			containers = await waitForSetup(targetState);
			const serviceName = serviceNames[0];
			const { State } = containers.filter((ctn) =>
				ctn.Name.startsWith(`/${serviceName}`),
			)[0];

			const { StartedAt: startedAt } = State;

			const isRestartSuccessful = (ctns: Docker.ContainerInspectInfo[]) =>
				ctns.some(
					(ctn) =>
						ctn.Name.startsWith(`/${serviceName}`) &&
						ctn.State.StartedAt !== startedAt,
				);

			// Calling actions.executeServiceAction directly doesn't work
			// because it relies on querying target state of the balena-supervisor
			// container, which isn't accessible directly from sut.
			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/restart-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0] }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// One container should have the same Id as before the restart call, since
			// it wasn't restarted.
			const sharedIds = restartedContainers
				.map(({ Id }) => Id)
				.filter((id) => containers.some((ctn) => ctn.Id === id));
			expect(sharedIds.length).to.equal(1);
		});

		// Since restart-service follows the same code paths as start|stop-service,
		// these lock test cases should be sufficient to cover all three service actions.
		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should not restart service when user locks are present', async () => {
			containers = await waitForSetup(targetState);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/restart-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0] }))
				.expect(423);

			// Containers should not have been restarted
			const containersAfterRestart = await waitForSetup(targetState);
			expect(
				containersAfterRestart.map((ctn) => ctn.State.StartedAt),
			).to.deep.include.members(containers.map((ctn) => ctn.State.StartedAt));

			// Remove the lock
			await fs.rm(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);
		});

		// FIXME: This is not easy to test as it modifies balena-supervisor-sut's
		// in-memory lockfile store, which is not accessible from this test process.
		it.skip('should restart service when user locks are present if force is specified', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers
					.filter((ctn) => ctn.Name.includes(serviceNames[0]))
					.map((ctn) => ctn.State.StartedAt),
			);

			// Create a lock
			await touch(`${lockdir}/${APP_ID}/${serviceNames[0]}/updates.lock`);

			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/restart-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0], force: true }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Wait briefly for state to settle which includes releasing locks
			await setTimeout(500);

			// User lock should be overridden
			expect(
				await fs.readdir(`${lockdir}/${APP_ID}/${serviceNames[0]}`),
			).to.deep.equal([]);
		});

		it('should stop a running service', async () => {
			containers = await waitForSetup(targetState);

			// Calling actions.executeServiceAction directly doesn't work
			// because it relies on querying target state of the balena-supervisor
			// container, which isn't accessible directly from sut.
			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/stop-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0] }));

			const stoppedContainers = await waitForSetup(targetState, isSomeExited);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isSomeExited(stoppedContainers)).to.be.true;

			// Containers should have the same Ids since none should be removed
			expect(stoppedContainers.map(({ Id }) => Id)).to.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Start the container
			const containerToStart = containers.find(({ Name }) =>
				new RegExp(serviceNames[0]).test(Name),
			);
			if (!containerToStart) {
				expect.fail(
					`Expected a container matching "${serviceNames[0]}" to be present`,
				);
			}
			await docker.getContainer(containerToStart.Id).start();
		});

		it('should start a stopped service', async () => {
			containers = await waitForSetup(targetState);

			// First, stop the container so we can test the start step
			const containerToStop = containers.find((ctn) =>
				new RegExp(serviceNames[0]).test(ctn.Name),
			);
			if (!containerToStop) {
				expect.fail(
					`Expected a container matching "${serviceNames[0]}" to be present`,
				);
			}
			await docker.getContainer(containerToStop.Id).stop();

			// Calling actions.executeServiceAction directly doesn't work
			// because it relies on querying target state of the balena-supervisor
			// container, which isn't accessible directly from sut.
			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v2/applications/1/start-service')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ serviceName: serviceNames[0] }));

			const runningContainers = await waitForSetup(targetState, isAllRunning);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isAllRunning(runningContainers)).to.be.true;

			// Containers should have the same Ids since none should be removed
			expect(runningContainers.map(({ Id }) => Id)).to.have.members(
				containers.map((ctn) => ctn.Id),
			);
		});

		// This test should be ordered last in this `describe` block, because the test compares
		// the `CreatedAt` timestamps of volumes to determine whether purge was successful. Thus,
		// ordering the assertion last will ensure some time has passed between the first `CreatedAt`
		// and the `CreatedAt` extracted from the new volume to pass this assertion.
		it('should purge an application by removing services then removing volumes', async () => {
			containers = await waitForSetup(targetState);
			const isRestartSuccessful = startTimesChanged(
				containers.map((ctn) => ctn.State.StartedAt),
			);

			// Get volume metadata. As the name stays the same, we just need to check that the volume
			// has been deleted & recreated. We can use the CreatedAt timestamp to determine this.
			const volume = (await docker.listVolumes()).Volumes.find((vol) =>
				/data/.test(vol.Name),
			);
			if (!volume) {
				expect.fail('Expected initial volume with name matching "data"');
			}
			// CreatedAt is a valid key but isn't typed properly
			const createdAt = (volume as any).CreatedAt;

			// Calling actions.doPurge won't work as intended because purge relies on
			// setting and applying intermediate state before applying target state again,
			// but target state is set in the balena-supervisor container instead of sut.
			// NOTE: if running ONLY this test, it has a chance of failing since the first and
			// second volume creation happen in quick succession (sometimes in the same second).
			await request(BALENA_SUPERVISOR_ADDRESS)
				.post('/v1/purge')
				.set('Content-Type', 'application/json')
				.send(JSON.stringify({ appId: 1 }));

			const restartedContainers = await waitForSetup(
				targetState,
				isRestartSuccessful,
			);

			// Technically the wait function above should already verify that the two
			// containers have been restarted, but verify explcitly with an assertion
			expect(isRestartSuccessful(restartedContainers)).to.be.true;

			// Containers should have different Ids since they're recreated
			expect(restartedContainers.map(({ Id }) => Id)).to.not.have.members(
				containers.map((ctn) => ctn.Id),
			);

			// Volume should be recreated
			const newVolume = (await docker.listVolumes()).Volumes.find((vol) =>
				/data/.test(vol.Name),
			);
			if (!volume) {
				expect.fail('Expected recreated volume with name matching "data"');
			}
			expect((newVolume as any).CreatedAt).to.not.equal(createdAt);
		});
	});
});

describe('reboots or shuts down device', () => {
	it('reboots device', async () => {
		await actions.executeDeviceAction({ action: 'reboot' });
		// The reboot method delays the call by one second
		await setTimeout(1500);
		await expect(
			dbusSend(
				'org.freedesktop.login1',
				'/org/freedesktop/login1',
				'org.freedesktop.DBus.Properties.Get',
				'string:org.freedesktop.login1.Manager',
				'string:MockState',
			),
		).to.eventually.equal('variant       string "rebooting"');
	});

	it('shuts down device', async () => {
		await actions.executeDeviceAction({ action: 'shutdown' });
		// The shutdown method delays the call by one second
		await setTimeout(1500);
		await expect(
			dbusSend(
				'org.freedesktop.login1',
				'/org/freedesktop/login1',
				'org.freedesktop.DBus.Properties.Get',
				'string:org.freedesktop.login1.Manager',
				'string:MockState',
			),
		).to.eventually.equal('variant       string "off"');
	});
});

describe('updates target state cache', () => {
	let updateStub: SinonStub;
	// Stub external dependencies. TargetState.update and api-binder methods
	// should be tested separately.
	before(async () => {
		updateStub = stub(TargetState, 'update').resolves();
		// updateTarget reads instantUpdates from the db
		await config.initialized();
	});

	after(() => {
		updateStub.restore();
	});

	afterEach(() => {
		updateStub.resetHistory();
	});

	it('updates target state cache if instant updates are enabled', async () => {
		await config.set({ instantUpdates: true });
		await actions.updateTarget();
		expect(updateStub).to.have.been.calledWith(false);
	});

	it('updates target state cache if force is specified', async () => {
		await config.set({ instantUpdates: false });
		await actions.updateTarget(true);
		expect(updateStub).to.have.been.calledWith(true);
	});

	it("doesn't update target state cache if instantUpdates and force are false", async () => {
		await config.set({ instantUpdates: false });
		await actions.updateTarget(false);
		expect(updateStub).to.not.have.been.called;
	});
});

describe('patches host config', () => {
	// Stub external dependencies
	let hostConfigPatch: SinonStub;
	before(async () => {
		await config.initialized();
	});
	beforeEach(() => {
		hostConfigPatch = stub(hostConfig, 'patch');
	});
	afterEach(() => {
		hostConfigPatch.restore();
	});

	it('patches host config', async () => {
		const conf = {
			network: {
				proxy: {
					type: 'socks5',
					noProxy: ['172.0.10.1'],
				},
				hostname: 'deadbeef',
			},
		};
		await actions.patchHostConfig(conf, true);
		expect(hostConfigPatch).to.have.been.calledWith(conf, true);
	});

	it('patches hostname as first 7 digits of uuid if hostname parameter is empty string', async () => {
		const conf = {
			network: {
				hostname: '',
			},
		};
		const uuid = await config.get('uuid');
		await actions.patchHostConfig(conf, true);
		expect(hostConfigPatch).to.have.been.calledWith(
			{ network: { hostname: uuid?.slice(0, 7) } },
			true,
		);
	});
});
