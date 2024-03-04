import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';

import log from './supervisor-console';

/**
 * Given a date integer in ms, return in a format acceptable by journalctl.
 * This function is intended to be used internally. Queries to POST /v2/journal-logs
 * should provide `since` and `until` as formats acceptable by journalctl and not
 * rely on the Supervisor to convert inputs into an appropriate format.
 *
 * Example output: '2014-03-25 03:59:56'
 */
export const toJournalDate = (timestamp: number): string =>
	new Date(timestamp).toISOString().replace(/T/, ' ').replace(/\..+$/, '');

export function spawnJournalctl(opts: {
	all: boolean;
	follow: boolean;
	count?: number | 'all';
	unit?: string;
	containerId?: string;
	format: string;
	filterString?: string;
	since?: string;
	until?: string;
}): ChildProcess {
	const args: string[] = [];
	if (opts.all) {
		args.push('-a');
	}
	if (opts.follow) {
		args.push('--follow');
	}
	if (opts.unit != null) {
		args.push('-u');
		args.push(opts.unit);
	}
	if (opts.containerId != null) {
		args.push('-t');
		args.push(opts.containerId);
	}
	if (opts.count != null) {
		args.push('-n');
		args.push(opts.count.toString());
	}
	if (opts.since != null) {
		args.push('-S');
		args.push(opts.since);
	}
	if (opts.until != null) {
		args.push('-U');
		args.push(opts.until);
	}
	args.push('-o');
	args.push(opts.format);

	if (opts.filterString) {
		args.push(opts.filterString);
	}

	log.debug('Spawning journalctl', args.join(' '));

	const journald = spawn('journalctl', args, {
		stdio: 'pipe',
	});

	return journald;
}
