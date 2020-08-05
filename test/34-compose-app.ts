import * as _ from 'lodash';
import { expect } from 'chai';

import * as appMock from './lib/application-state-mock';

import * as applicationManager from '../src/compose/application-manager';
import App from '../src/compose/app';
import * as config from '../src/config';
import * as dbFormat from '../src/device-state/db-format';

import Service from '../src/compose/service';
import Network from '../src/compose/network';
import Volume from '../src/compose/volume';
import {
	CompositionStep,
	CompositionStepAction,
} from '../src/compose/composition-steps';

const defaultContext = {
	localMode: false,
	availableImages: [],
	containerIds: {},
	downloading: [],
};

function createApp(
	services: Service[],
	networks: Network[],
	volumes: Volume[],
	target: boolean,
	appId = 1,
) {
	return new App(
		{
			appId,
			services,
			networks: _.keyBy(networks, 'name'),
			volumes: _.keyBy(volumes, 'name'),
		},
		target,
	);
}

function createService(
	conf: Dictionary<any>,
	appId = 1,
	serviceName = 'test',
	releaseId = 2,
	serviceId = 3,
	imageId = 4,
) {
	return Service.fromComposeObject(
		{
			appId,
			serviceName,
			releaseId,
			serviceId,
			imageId,
			...conf,
		},
		{} as any,
	);
}

function expectStep(
	action: CompositionStepAction,
	steps: CompositionStep[],
): number {
	const idx = _.findIndex(steps, { action });
	if (idx === -1) {
		throw new Error(`Expected to find step with action: ${action}`);
	}
	return idx;
}

describe('compose/app', () => {
	before(async () => {
		await config.initialized;
		await applicationManager.initialized;
	});
	beforeEach(() => {
		// Sane defaults
		appMock.mockSupervisorNetwork(true);
		appMock.mockManagers([], [], []);
		appMock.mockImages([], false, []);
	});
	afterEach(() => {
		appMock.unmockAll();
	});

	it.skip('should correctly migrate legacy applications');

	it('should correctly infer a volume create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		const idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume');
	});

	it('should correctly infer more than one volume create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {}),
				Volume.fromComposeObject('test-volume-2', 1, {}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		let idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume');
		delete steps[idx];
		idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume-2');
	});

	// We don't remove volumes until the end
	it('should correctly not infer a volume remove step when the app is still referenced', () => {
		const current = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {}),
				Volume.fromComposeObject('test-volume-2', 1, {}),
			],
			false,
		);
		const target = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume-2', 1, {})],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		expect(() => {
			expectStep('removeVolume', steps);
		}).to.throw();
	});

	it('should correctly infer volume recreation steps', () => {
		const current = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			false,
		);
		const target = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		let steps = current.nextStepsForAppUpdate(defaultContext, target);

		let idx = expectStep('removeVolume', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('config')
			.that.has.property('labels')
			.that.deep.equals({ 'io.balena.supervised': 'true' });

		current.volumes = {};
		steps = current.nextStepsForAppUpdate(defaultContext, target);
		idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('config')
			.that.has.property('labels')
			.that.deep.equals({ 'io.balena.supervised': 'true', test: 'test' });
	});

	it('should kill dependencies of a volume before changing config', () => {
		const current = createApp(
			[createService({ volumes: ['test-volume'] })],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			false,
		);
		const target = createApp(
			[createService({ volumes: ['test-volume'] })],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
	});

	it('should correctly infer to remove an apps volumes when it is no longer referenced', async () => {
		appMock.mockManagers(
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			[],
		);
		appMock.mockImages([], false, []);

		const origFn = dbFormat.getApps;
		// @ts-expect-error Assigning to a RO property
		dbFormat.getApps = () => Promise.resolve({});

		try {
			const steps = await applicationManager.getRequiredSteps();
			expect(steps).to.have.length(1);
			expect(steps[0]).to.have.property('action').that.equals('removeVolume');
		} finally {
			// @ts-expect-error Assigning to a RO property
			dbFormat.getApps = origFn;
		}
	});

	it('should correctly infer a network create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[Network.fromComposeObject('default', 1, {})],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('createNetwork', steps);
	});

	it('should correctly infer a network remove step', () => {
		const current = createApp(
			[],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('removeNetwork', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('name')
			.that.equals('test-network');
	});

	it('should correctly infer a network recreation step', () => {
		const current = createApp(
			[],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp(
			[],
			[
				Network.fromComposeObject('test-network', 1, {
					labels: { TEST: 'TEST' },
				}),
			],
			[],
			true,
		);

		let steps = current.nextStepsForAppUpdate(defaultContext, target);
		let idx = expectStep('removeNetwork', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('name')
			.that.equals('test-network');

		delete current.networks['test-network'];
		steps = current.nextStepsForAppUpdate(defaultContext, target);
		idx = expectStep('createNetwork', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-network');
	});

	it('should kill dependencies of networks before removing', () => {
		const current = createApp(
			[createService({ networks: { 'test-network': {} } })],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp([createService({})], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
	});

	it('should kill dependencies of networks before changing config', () => {
		const current = createApp(
			[createService({ networks: { 'test-network': {} } })],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp(
			[createService({ networks: { 'test-network': {} } })],
			[
				Network.fromComposeObject('test-network', 1, {
					labels: { test: 'test' },
				}),
			],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
		// We shouldn't try to remove the network until we have gotten rid of the dependencies
		expect(() => expectStep('removeNetwork', steps)).to.throw();
	});

	it('should not output a kill step for a service which is already stopping when changing a volume', () => {
		const service = createService({ volumes: ['test-volume'] });
		service.status = 'Stopping';
		const current = createApp(
			[service],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			false,
		);
		const target = createApp(
			[service],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expect(() => expectStep('kill', steps)).to.throw();
	});

	it('should create the default network if it does not exist', () => {
		const current = createApp([], [], [], false);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('createNetwork', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('default');
	});

	it.skip(
		'should create a kill step for service which is no longer referenced',
	);
	it.skip(
		'should emit a noop when a service which is no longer referenced is already stopping',
	);
	it.skip('should remove a dead container');
	it.skip('should emit a noop when a service has an image downloading');
	it.skip(
		'should emit an updateMetadata step when a service has not changed but the release has',
	);
	it.skip('should start a container which has not been started');
	it.skip('should stop a container which has stoppped as its target');
	it.skip(
		'should not start a container when it depends on a service which is being installed',
	);
	it.skip(
		'should emit a fetch step when an image has not been downloaded for a service',
	);
	it.skip(
		'should create a start step when all that changes is a running state',
	);
	it.skip(
		'should not infer a fetch step when the download is already in progress',
	);
	it.skip(
		'should create a kill step when a service has to be updated but the strategy is kill-then-download',
	);
	it.skip(
		'should not infer a kill step with the default strategy if a dependency is not downloaded',
	);
	it.skip(
		'should create several kill steps as long as there is no unmet dependencies',
	);
	it.skip('should start a dependency container first');
	it.skip('infers to start a service once its dependencies have been met');
	it.skip('should remove spurious containers');
});
