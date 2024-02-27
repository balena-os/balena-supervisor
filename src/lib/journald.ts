import { ChildProcess, spawn } from 'child_process';

import log from './supervisor-console';
import { Readable } from 'stream';

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

export interface JournalctlOpts {
	all: boolean;
	follow: boolean;
	unit?: string;
	containerId?: string;
	count?: number;
	since?: string;
	until?: string;
	format?: string;
	matches?: string;
}

// A journalctl process has a non-null stdout
export interface JournalctlProcess extends ChildProcess {
	stdout: Readable;
}

export function spawnJournalctl(opts: JournalctlOpts): JournalctlProcess {
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
	if (opts.format != null) {
		args.push(opts.format);
	} else {
		args.push('short');
	}
	// Filter logs by space-seperated matches per
	// journalctl interface of `journalctl [OPTIONS..] [MATCHES..]`
	if (opts.matches) {
		args.push(opts.matches);
	}

	log.debug('Spawning journalctl', args.join(' '));

	const journald = spawn('journalctl', args, {
		stdio: 'pipe',
	});

	return journald;
}
