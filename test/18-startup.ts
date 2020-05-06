import { Supervisor } from '../src/supervisor';
import { expect } from './lib/chai-config';

describe('Startup', () => {
	it('should startup correctly', function() {
		const supervisor = new Supervisor();
		expect(supervisor.init()).to.not.throw;
		// Cast as any to access private properties
		const anySupervisor = supervisor as any;
		expect(anySupervisor.db).to.not.be.null;
		expect(anySupervisor.config).to.not.be.null;
		expect(anySupervisor.logger).to.not.be.null;
		expect(anySupervisor.deviceState).to.not.be.null;
		expect(anySupervisor.apiBinder).to.not.be.null;
	});
});
