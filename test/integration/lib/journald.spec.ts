import { expect } from 'chai';
import { ChildProcess } from 'child_process';

import { toJournalDate, spawnJournalctl } from '~/src/lib/journald';

describe('lib/journald', () => {
	describe('toJournalDate', () => {
		it('should convert a timestamp in ms to a journalctl date', () => {
			const journalDate = toJournalDate(
				new Date('2019-01-01T00:00:00.000Z').getTime(),
			);
			expect(journalDate).to.equal('2019-01-01 00:00:00');
		});
	});

	describe('spawnJournalctl', () => {
		it('should spawn a journalctl process with defaults', () => {
			const journalProcess = spawnJournalctl({
				all: false,
				follow: false,
			});

			expect(journalProcess).to.have.property('stdout');
			expect(journalProcess).to.be.instanceOf(ChildProcess);
			expect(journalProcess)
				.to.have.property('spawnargs')
				.that.deep.equals(['journalctl', '-o', 'short']);

			journalProcess.kill('SIGKILL');
		});

		it('should spawn a journalctl process with valid options', () => {
			const journalProcess = spawnJournalctl({
				all: true,
				follow: true,
				unit: 'test-unit',
				containerId: 'test-container',
				count: 10,
				since: '2019-01-01 00:00:00',
				until: '2019-01-02 00:00:00',
				format: 'json',
				matches: '_SYSTEMD_UNIT=test-unit',
			});

			expect(journalProcess).to.have.property('stdout');
			expect(journalProcess).to.be.instanceOf(ChildProcess);
			expect(journalProcess)
				.to.have.property('spawnargs')
				.that.deep.equals([
					'journalctl',
					'-a',
					'--follow',
					'-u',
					'test-unit',
					'-t',
					'test-container',
					'-n',
					'10',
					'-S',
					'2019-01-01 00:00:00',
					'-U',
					'2019-01-02 00:00:00',
					'-o',
					'json',
					'_SYSTEMD_UNIT=test-unit',
				]);

			journalProcess.kill('SIGKILL');
		});
	});
});
