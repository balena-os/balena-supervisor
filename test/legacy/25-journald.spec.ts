import { SinonStub, stub } from 'sinon';
import { expect } from 'chai';

import constants = require('~/lib/constants');
import { spawnJournalctl } from '~/lib/journald';

describe('journald', () => {
	let spawn: SinonStub;

	beforeEach((done) => {
		spawn = stub(require('child_process'), 'spawn');
		done();
	});

	afterEach((done) => {
		spawn.restore();
		done();
	});

	it('spawnJournalctl calls spawn child process with expected args', () => {
		spawnJournalctl({
			all: true,
			follow: true,
			count: 10,
			unit: 'nginx.service',
			containerId: 'abc123',
			format: 'json-pretty',
		});

		const expectedCommand = `chroot`;
		const expectedCoreArgs = [`${constants.rootMountPoint}`, 'journalctl'];
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
		const actualCoreArgs = spawn.firstCall.args[1].slice(0, 2);
		const actualOptionalArgs = spawn.firstCall.args[1].slice(2);

		expect(spawn.calledOnce).to.be.true;

		expect(actualCommand).deep.equal(expectedCommand);
		expect(actualCoreArgs).deep.equal(expectedCoreArgs);

		expectedOptionalArgs.forEach((arg) => {
			expect(actualOptionalArgs).to.include(arg);
		});
	});
});
