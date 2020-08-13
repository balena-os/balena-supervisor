import { expect } from 'chai';
import _ = require('lodash');

import * as dbFormat from '../src/device-state/db-format';
import * as appMock from './lib/application-state-mock';

import * as applicationManager from '../src/compose/application-manager';
import * as config from '../src/config';
import * as deviceState from '../src/device-state';

import Service from '../src/compose/service';
import Network from '../src/compose/network';

describe('compose/application-manager', () => {
	before(async () => {
		await config.initialized;
		await dbFormat.setApps({}, 'test');
	});
	beforeEach(() => {
		appMock.mockSupervisorNetwork(true);
	});
	afterEach(() => {
		appMock.unmockAll();
	});

	it('should create an App from current state', async () => {
		appMock.mockManagers(
			[
				Service.fromDockerContainer(
					require('./data/docker-states/simple/inspect.json'),
				),
			],
			[],
			[],
		);

		const apps = await applicationManager.getCurrentApps();
		expect(Object.keys(apps)).to.have.length(1);
		const app = apps[1011165];
		expect(app).to.have.property('appId').that.equals(1011165);
		expect(app).to.have.property('services');
		const services = _.keyBy(app.services, 'serviceId');
		expect(services).to.have.property('43697');
		expect(services[43697]).to.have.property('serviceName').that.equals('main');
	});

	it('should create multiple Apps when the current state reflects that', async () => {
		appMock.mockManagers(
			[
				Service.fromDockerContainer(
					require('./data/docker-states/simple/inspect.json'),
				),
			],
			[],
			[
				Network.fromDockerNetwork(
					require('./data/docker-states/networks/1623449_default.json'),
				),
			],
		);

		const apps = await applicationManager.getCurrentApps();
		expect(Object.keys(apps)).to.deep.equal(['1011165', '1623449']);
	});

	it('should infer that we need to create the supervisor network if it does not exist', async () => {
		appMock.mockSupervisorNetwork(false);
		appMock.mockManagers([], [], []);
		appMock.mockImages([], false, []);

		const target = await deviceState.getTarget();

		const steps = await applicationManager.getRequiredSteps(target.local.apps);
		expect(steps).to.have.length(1);
		expect(steps[0])
			.to.have.property('action')
			.that.equals('ensureSupervisorNetwork');
	});

	it('should kill a service which depends on the supervisor network, if we need to create the network', async () => {
		appMock.mockSupervisorNetwork(false);
		appMock.mockManagers(
			[
				Service.fromDockerContainer(
					require('./data/docker-states/supervisor-api/inspect.json'),
				),
			],
			[],
			[],
		);
		appMock.mockImages([], false, []);
		const target = await deviceState.getTarget();

		const steps = await applicationManager.getRequiredSteps(target.local.apps);

		expect(steps).to.have.length(1);
		expect(steps[0]).to.have.property('action').that.equals('kill');
		expect(steps[0])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('main');
	});

	it('should infer a cleanup step when a cleanup is required', async () => {
		appMock.mockManagers([], [], []);
		appMock.mockImages([], true, []);

		const target = await deviceState.getTarget();

		const steps = await applicationManager.getRequiredSteps(target.local.apps);
		expect(steps).to.have.length(1);
		expect(steps[0]).to.have.property('action').that.equals('cleanup');
	});

	it('should infer that an image should be removed if it is no longer referenced in current or target state', async () => {
		appMock.mockManagers([], [], []);
		appMock.mockImages([], false, [
			{
				name: 'registry2.balena-cloud.com/v2/asdasdasdasd@sha256:10',
				appId: 1,
				serviceId: 1,
				serviceName: 'test',
				imageId: 10,
				dependent: 0,
				releaseId: 4,
			},
		]);

		const target = await deviceState.getTarget();

		const steps = await applicationManager.getRequiredSteps(target.local.apps);
		expect(steps).to.have.length(1);
		expect(steps[0]).to.have.property('action').that.equals('removeImage');
		expect(steps[0])
			.to.have.property('image')
			.that.has.property('name')
			.that.equals('registry2.balena-cloud.com/v2/asdasdasdasd@sha256:10');
	});

	it.skip(
		'should infer that an image should be saved if it is not in the database',
	);

	it.skip('should correctly generate steps for multiple apps');
});
