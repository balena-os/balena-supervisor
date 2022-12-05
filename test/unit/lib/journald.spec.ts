import { SinonStub, stub } from 'sinon';
import { expect } from 'chai';

import { spawnJournalctl } from '~/lib/journald';

describe('lib/journald', () => {
	let spawn: SinonStub;

	beforeEach((done) => {
		spawn = stub(require('child_process'), 'spawn');
		done();
	});

	afterEach((done) => {
		spawn.restore();
		done();
	});

	// TODO: this test is not really that useful as it basically is just testing
	// the internal implementation of the method
	it('spawnJournalctl calls spawn child process with expected args', () => {
		spawnJournalctl({
			all: true,
			follow: true,
			count: 10,
			unit: 'nginx.service',
			containerId: 'abc123',
			format: 'json-pretty',
		});

		const expectedCommand = `journalctl`;
		const expectedOptionalArgs = [
			'-a',
			'--follow',
			'-u',
			'nginx.service',
			'-t',
			'abc123',
			'-n',
			'10',
			'-o',
			'json-pretty',
		];

		const actualCommand = spawn.firstCall.args[0];
		const actualOptionalArgs = spawn.firstCall.args[1];

		expect(spawn.calledOnce).to.be.true;

		expect(actualCommand).deep.equal(expectedCommand);

		expectedOptionalArgs.forEach((arg) => {
			expect(actualOptionalArgs).to.include(arg);
		});
	});
});
