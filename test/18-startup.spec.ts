import { SinonStub, stub } from 'sinon';
import { expect } from './lib/chai-config';
import * as _ from 'lodash';

import * as APIBinder from '../src/api-binder';
import { ApplicationManager } from '../src/application-manager';
import * as deviceState from '../src/device-state';
import * as constants from '../src/lib/constants';
import { docker } from '../src/lib/docker-utils';
import { Supervisor } from '../src/supervisor';

import * as config from '../src/config';

describe('Startup', () => {
	let startStub: SinonStub;
	let vpnStatusPathStub: SinonStub;
	let appManagerStub: SinonStub;
	let deviceStateStub: SinonStub;
	let dockerStub: SinonStub;

	before(async () => {
		await deviceState.initialized;

		startStub = stub(APIBinder as any, 'start').returns(Promise.resolve());
		appManagerStub = stub(ApplicationManager.prototype, 'init').returns(
			Promise.resolve(),
		);
		vpnStatusPathStub = stub(constants, 'vpnStatusPath').returns('');
		deviceStateStub = stub(deviceState, 'applyTarget').returns(
			Promise.resolve(),
		);
		dockerStub = stub(docker, 'listContainers').returns(Promise.resolve([]));
	});

	after(() => {
		startStub.restore();
		appManagerStub.restore();
		vpnStatusPathStub.restore();
		deviceStateStub.restore();
		dockerStub.restore();
	});

	it('should startup correctly', async () => {
		const supervisor = new Supervisor();
		expect(await supervisor.init()).to.not.throw;
		// Cast as any to access private properties
		const anySupervisor = supervisor as any;
		expect(anySupervisor.db).to.not.be.null;
		expect(anySupervisor.config).to.not.be.null;
		expect(anySupervisor.logger).to.not.be.null;
		expect(anySupervisor.deviceState).to.not.be.null;
		expect(anySupervisor.apiBinder).to.not.be.null;
	});
});
