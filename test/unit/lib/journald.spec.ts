import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import { expect } from 'chai';
import childProcess from 'child_process';

import { spawnJournalctl } from '~/lib/journald';

describe('lib/journald', () => {
	let spawn: SinonStub;

	beforeEach((done) => {
		spawn = stub(childProcess, 'spawn');
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
			filter: ['_SYSTEMD_UNIT=test.service', '_SYSTEMD_UNIT=test2.service'],
			since: '2014-03-25 03:59:56.654563',
			until: '2014-03-25 03:59:59.654563',
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
			'-S',
			'2014-03-25 03:59:56.654563',
			'-U',
			'2014-03-25 03:59:59.654563',
			'_SYSTEMD_UNIT=test.service',
			'_SYSTEMD_UNIT=test2.service',
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
