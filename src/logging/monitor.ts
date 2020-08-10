import * as JSONstream from 'JSONStream';
import { delay } from 'bluebird';

import * as journald from '../lib/journald';
import log from '../lib/supervisor-console';

export type MonitorHook = (data: string) => Resolvable<void>;
// Here we store the hooks for container logs. When we start a container, we will register
// a hook to be called with the container log
const containerMonitors: Dictionary<(data: string) => Resolvable<void>> = {};

// Wait 5s when journalctl failed before trying to read the logs again
const JOURNALCTL_ERROR_RETRY_DELAY = 5000;

// This is nowhere near the amount of fields provided by journald, but simply the ones
// that we are interested in
interface JournaldRow {
	CONTAINER_ID_FULL?: string;
	CONTAINER_NAME?: string;
	MESSAGE: string | number[];
}

export function addMonitorForContainer(containerId: string, hook: MonitorHook) {
	containerMonitors[containerId] = hook;
}

export function monitorExistsForContainer(containerId: string): boolean {
	return containerId in containerMonitors;
}

export function startLogMonitor() {
	// FIXME: --since
	const journalctl = journald.spawnJournalctl({
		all: true,
		follow: true,
		format: 'json',
		filterString: '_SYSTEMD_UNIT=balena.service',
	});

	journalctl.stdout?.pipe(
		JSONstream.parse(true).on('data', (row: JournaldRow) => {
			if (row.CONTAINER_ID_FULL && row.CONTAINER_NAME !== 'resin_supervisor') {
				// console.log(row);
				console.log('==================================================');
				console.log(containerMonitors);
				console.log(row.CONTAINER_ID_FULL);
				const id = row.CONTAINER_ID_FULL;
				console.log('==================================================');
				const logline = messageFieldToString(row.MESSAGE);
				if (logline != null && containerMonitors[id] != null) {
					containerMonitors[id](logline);
				}
			}
		}),
	);
	journalctl.stderr?.on('data', async (data: Buffer) => {
		log.error('Non-empty stderr stream from journalctl log fetching: ', data.toString());
		await delay(5000);
		startLogMonitor();
	});
}

function messageFieldToString(entry: JournaldRow['MESSAGE']): string | null {
	if (Array.isArray(entry)) {
		return String.fromCharCode(...entry);
	} else if (typeof entry === 'string') {
		return entry;
	} else {
		log.error(`Unknown journald message field type: ${typeof entry}. Dropping log.`);
		return null;
	}
}
