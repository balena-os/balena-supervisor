import JSONstream from 'JSONStream';

import type { SpawnJournalctlOpts } from '../lib/journald';
import { spawnJournalctl, toJournalDate } from '../lib/journald';
import log from '../lib/supervisor-console';
import { setTimeout } from 'timers/promises';

export type MonitorHook = (message: {
	message: string;
	isStdErr: boolean;
	timestamp: number;
}) => void;

// This is nowhere near the amount of fields provided by journald, but simply the ones
// that we are interested in
interface JournalRow {
	CONTAINER_ID_FULL?: string;
	CONTAINER_NAME?: string;
	MESSAGE: string | number[];
	PRIORITY: string;
	__REALTIME_TIMESTAMP: string;
}

// Wait 5s when journalctl failed before trying to read the logs again
const JOURNALCTL_ERROR_RETRY_DELAY = 5000;
const JOURNALCTL_ERROR_RETRY_DELAY_MAX = 15 * 60 * 1000;

function messageFieldToString(entry: JournalRow['MESSAGE']): string | null {
	if (Array.isArray(entry)) {
		return String.fromCharCode(...entry);
	} else if (typeof entry === 'string') {
		return entry;
	} else {
		log.error(
			`Unknown journald message field type: ${typeof entry}. Dropping log.`,
		);
		return null;
	}
}

/**
 * Streams logs from journalctl and calls container hooks when a record is received matching container id
 */
class LogMonitor {
	private containers: {
		[containerId: string]: {
			hook: MonitorHook;
		};
	} = {};
	private setupAttempts = 0;

	// Only stream logs since the start of the supervisor
	private lastSentTimestamp = Date.now() - performance.now();

	public start() {
		this.streamLogsFromJournal(
			{
				all: true,
				follow: true,
				format: 'json',
				filterString: '_SYSTEMD_UNIT=balena.service',
				since: toJournalDate(this.lastSentTimestamp),
			},
			(row) => {
				if (row.CONTAINER_ID_FULL && this.containers[row.CONTAINER_ID_FULL]) {
					this.setupAttempts = 0;
					this.handleRow(row);
				}
			},
			(data) => {
				log.error('journalctl - balena.service stderr: ', data.toString());
			},
			async () => {
				log.debug('balena.service journalctl process exit.');
				// On exit of process try to create another
				const wait = Math.min(
					2 ** this.setupAttempts++ * JOURNALCTL_ERROR_RETRY_DELAY,
					JOURNALCTL_ERROR_RETRY_DELAY_MAX,
				);
				log.debug(
					`Spawning another process to watch balena.service logs in ${
						wait / 1000
					}s`,
				);
				await setTimeout(wait);
				return this.start();
			},
		);
	}

	public isAttached(containerId: string): boolean {
		return containerId in this.containers;
	}

	public async attach(containerId: string, hook: MonitorHook) {
		if (!this.containers[containerId]) {
			this.containers[containerId] = {
				hook,
			};
		}
	}

	public async detach(containerId: string) {
		delete this.containers[containerId];
	}

	private streamLogsFromJournal(
		options: SpawnJournalctlOpts,
		onRow: (row: JournalRow) => void,
		onError: (data: Buffer) => void,
		onExit: () => void,
	): ReturnType<typeof spawnJournalctl> {
		const journalctl = spawnJournalctl(options);
		journalctl.stdout?.pipe(JSONstream.parse(true).on('data', onRow));
		journalctl.stderr?.on('data', onError);
		journalctl.on('exit', onExit);
		return journalctl;
	}

	private handleRow(row: JournalRow) {
		if (
			row.CONTAINER_ID_FULL == null ||
			row.CONTAINER_NAME === 'balena_supervisor' ||
			row.CONTAINER_NAME === 'resin_supervisor'
		) {
			return;
		}
		const containerId = row.CONTAINER_ID_FULL;
		if (this.containers[containerId] == null) {
			return;
		}
		const message = messageFieldToString(row.MESSAGE);
		if (message == null) {
			return;
		}
		const isStdErr = row.PRIORITY === '3';
		const timestamp = Math.floor(Number(row.__REALTIME_TIMESTAMP) / 1000); // microseconds to milliseconds

		this.containers[containerId].hook({ message, isStdErr, timestamp });
		this.lastSentTimestamp = timestamp;
	}
}

const logMonitor = new LogMonitor();

export default logMonitor;
