import { ChildProcess, spawn } from 'child_process';

import constants = require('./constants');
import log from './supervisor-console';

export function spawnJournalctl(opts: {
	all: boolean;
	follow: boolean;
	count?: number;
	unit?: string;
	containerId?: string;
	format: string;
}): ChildProcess {
	const args = [
		// The directory we want to run the chroot from
		constants.rootMountPoint,
		'journalctl',
	];
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
	args.push('-o');
	args.push(opts.format);

	log.debug('Spawning journald with: chroot ', args.join(' '));

	const journald = spawn('chroot', args, {
		stdio: 'pipe',
	});

	return journald;
}
