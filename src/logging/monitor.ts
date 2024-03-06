import JSONstream from 'JSONStream';

import * as db from '../db';
import { spawnJournalctl, toJournalDate } from '../lib/journald';
import log from '../lib/supervisor-console';
import { setTimeout } from 'timers/promises';

export type MonitorHook = (message: {
	message: string;
	isStdErr: boolean;
	timestamp: number;
}) => Resolvable<void>;

// This is nowhere near the amount of fields provided by journald, but simply the ones
// that we are interested in
interface JournalRow {
	CONTAINER_ID_FULL?: string;
	CONTAINER_NAME?: string;
	MESSAGE: string | number[];
	PRIORITY: string;
	__REALTIME_TIMESTAMP: string;
}

// Flush every 10 mins
const DB_FLUSH_INTERVAL = 10 * 60 * 1000;

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
			follow: boolean;
			timestamp: number;
			writeRequired: boolean;
		};
	} = {};
	private setupAttempts = 0;

	public constructor() {
		setInterval(() => this.flushDb(), DB_FLUSH_INTERVAL);
	}

	public start() {
		this.streamLogsFromJournal(
			{
				all: true,
				follow: true,
				format: 'json',
				filterString: '_SYSTEMD_UNIT=balena.service',
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
			() => {
				// noop for closed
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
				follow: false,
				timestamp: Date.now(),
				writeRequired: false,
			};
			this.containers[containerId].timestamp =
				await this.getContainerSentTimestamp(containerId);
			this.backfill(containerId, this.containers[containerId].timestamp);
		}
	}

	public async detach(containerId: string) {
		delete this.containers[containerId];
		await db.models('containerLogs').delete().where({ containerId });
	}

	private streamLogsFromJournal(
		options: Parameters<typeof spawnJournalctl>[0],
		onRow: (row: JournalRow) => void,
		onError: (data: Buffer) => void,
		onClose?: () => void,
		onExit?: () => void,
	): ReturnType<typeof spawnJournalctl> {
		const journalctl = spawnJournalctl(options);
		journalctl.stdout?.pipe(JSONstream.parse(true).on('data', onRow));
		journalctl.stderr?.on('data', onError);
		if (onClose) {
			journalctl.on('close', onClose);
		}
		if (onExit) {
			journalctl.on('exit', onExit);
		}
		return journalctl;
	}

	/**
	 * stream logs from lastSentTimestamp until now so logs are not missed if the container started before supervisor
	 */
	private backfill(containerId: string, lastSentTimestamp: number) {
		this.streamLogsFromJournal(
			{
				all: true,
				follow: false,
				format: 'json',
				filterString: `CONTAINER_ID_FULL=${containerId}`,
				since: toJournalDate(lastSentTimestamp + 1), // increment to exclude last sent log
			},
			(row) => this.handleRow(row),
			(data) => {
				log.error(
					`journalctl - container ${containerId} stderr: `,
					data.toString(),
				);
			},
			() => {
				this.containers[containerId].follow = true;
			},
		);
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
		this.updateContainerSentTimestamp(containerId, timestamp);

		// WARNING: this could lead to a memory leak as the hook is not being awaited
		// and the journal can be very verbose
		void this.containers[containerId].hook({ message, isStdErr, timestamp });
	}

	private updateContainerSentTimestamp(
		containerId: string,
		timestamp: number,
	): void {
		this.containers[containerId].timestamp = timestamp;
		this.containers[containerId].writeRequired = true;
	}

	private async getContainerSentTimestamp(
		containerId: string,
	): Promise<number> {
		try {
			const row = await db
				.models('containerLogs')
				.select('lastSentTimestamp')
				.where({ containerId })
				.first();

			if (!row) {
				const now = Date.now();
				await db
					.models('containerLogs')
					.insert({ containerId, lastSentTimestamp: now });
				return now;
			} else {
				return row.lastSentTimestamp;
			}
		} catch (e) {
			log.error(
				'There was an error retrieving the container log timestamps:',
				e,
			);
			return Date.now();
		}
	}

	private async flushDb() {
		log.debug('Attempting container log timestamp flush...');
		try {
			for (const containerId of Object.keys(this.containers)) {
				// Avoid writing to the db if we don't need to
				if (!this.containers[containerId].writeRequired) {
					continue;
				}
				await db.models('containerLogs').where({ containerId }).update({
					lastSentTimestamp: this.containers[containerId].timestamp,
				});
				this.containers[containerId].writeRequired = false;
			}
		} catch (e) {
			log.error('There was an error storing the container log timestamps:', e);
		}
		log.debug('Container log timestamp flush complete');
	}
}

const logMonitor = new LogMonitor();

export default logMonitor;
