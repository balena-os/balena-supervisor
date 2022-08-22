import { SinonStub, stub } from 'sinon';
import { expect } from 'chai';
import * as _ from 'lodash';

import * as apiBinder from '~/src/api-binder';
import * as applicationManager from '~/src/compose/application-manager';
import * as deviceState from '~/src/device-state';
import * as constants from '~/src/lib/constants';
import { docker } from '~/lib/docker-utils';
import { Supervisor } from '~/src/supervisor';

describe('Startup', () => {
	let startStub: SinonStub;
	let vpnStatusPathStub: SinonStub;
	let deviceStateStub: SinonStub;
	let dockerStub: SinonStub;

	before(async () => {
		startStub = stub(apiBinder as any, 'start').resolves();
		deviceStateStub = stub(deviceState, 'applyTarget').resolves();
		// @ts-expect-error
		applicationManager.initialized = Promise.resolve();
		vpnStatusPathStub = stub(constants, 'vpnStatusPath').returns('');
		dockerStub = stub(docker, 'listContainers').returns(Promise.resolve([]));
	});

	after(() => {
		startStub.restore();
		vpnStatusPathStub.restore();
		deviceStateStub.restore();
		dockerStub.restore();
	});

	it('should startup correctly', async () => {
		const supervisor = new Supervisor();
		await supervisor.init();

		// Cast as any to access private properties
		const anySupervisor = supervisor as any;
		expect(anySupervisor.db).to.not.be.null;
		expect(anySupervisor.config).to.not.be.null;
		expect(anySupervisor.logger).to.not.be.null;
		expect(anySupervisor.deviceState).to.not.be.null;
		expect(anySupervisor.apiBinder).to.not.be.null;
	});
});
