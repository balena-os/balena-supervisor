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

export interface SpawnJournalctlOpts {
	all: boolean;
	follow: boolean;
	count?: number | 'all';
	unit?: string;
	containerId?: string;
	format: string;
	filter?: string | string[];
	since?: string;
	until?: string;
}

export function spawnJournalctl(opts: SpawnJournalctlOpts): ChildProcess {
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

	if (opts.filter != null) {
		// A single filter argument without spaces can be passed as a string
		if (typeof opts.filter === 'string') {
			args.push(opts.filter);
		} else {
			// Multiple filter arguments need to be passed as an array of strings
			// instead of a single string with spaces, as `spawn` will interpret
			// the single string as a single argument to journalctl, which is invalid.
			args.push(...opts.filter);
		}
	}

	log.debug('Spawning journalctl', args.join(' '));

	const journald = spawn('journalctl', args, {
		stdio: 'pipe',
	});

	return journald;
}
