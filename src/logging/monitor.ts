import { pipeline } from 'stream/promises';

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

// Wait 5s when journalctl failed before trying to read the logs again
const JOURNALCTL_ERROR_RETRY_DELAY = 5000;
const JOURNALCTL_ERROR_RETRY_DELAY_MAX = 15 * 60 * 1000;

// System services that configure boot configs upon receiving changes to config.json.
// The Supervisor streams these logs for better user visibility into these config changes.
const SYSTEM_CONFIG_UNITS = ['os-fan-profile.service', 'os-power-mode.service'];

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

async function* splitStream(chunkIterable: AsyncIterable<any>) {
	let previous = '';
	for await (const chunk of chunkIterable) {
		previous += chunk;
		const lines = previous.split(/\r?\n/);
		previous = lines.pop() ?? '';
		yield* lines;
	}

	if (previous.length > 0) {
		yield previous;
	}
}

const getFilterString = (units: string[]) =>
	units.map((unit) => `_SYSTEMD_UNIT=${unit}`).join(' ');

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

	public async start(
		logSystemMessage: (
			message: string,
			eventObj?: Dictionary<any> | null,
			eventName?: string,
			track?: boolean,
		) => void,
	): Promise<void> {
		try {
			// TODO: do not spawn journalctl if logging is not enabled
			const { stdout, stderr } = spawnJournalctl({
				all: true,
				follow: true,
				format: 'json',
				filterString: getFilterString(
					['balena.service'].concat(SYSTEM_CONFIG_UNITS),
				),
				since: toJournalDate(this.lastSentTimestamp),
			});
			if (!stdout) {
				// this will be catched below
				throw new Error('failed to open process stream');
			}

			stderr?.on('data', (data) =>
				log.error('System log monitor error during startup: ', data.toString()),
			);

			const self = this;

			await pipeline(stdout, splitStream, async function (lines) {
				self.setupAttempts = 0;
				for await (const line of lines) {
					try {
						const row = JSON.parse(line);
						if (
							row.CONTAINER_ID_FULL &&
							self.containers[row.CONTAINER_ID_FULL]
						) {
							await self.handleRow(row);
						} else if (SYSTEM_CONFIG_UNITS.includes(row._SYSTEMD_UNIT)) {
							await self.handleSystemRow(row, logSystemMessage);
						}
					} catch {
						// ignore parsing errors
					}
				}
			});
			log.debug('System log monitor: journalctl process exit.');
		} catch (e: any) {
			log.error('System log monitor error: ', e.message ?? e);
		}

		// On exit of process try to create another
		const wait = Math.min(
			2 ** this.setupAttempts++ * JOURNALCTL_ERROR_RETRY_DELAY,
			JOURNALCTL_ERROR_RETRY_DELAY_MAX,
		);
		log.debug(
			`Spawning another process to watch system logs in ${wait / 1000}s`,
		);
		await setTimeout(wait);
		void this.start(logSystemMessage);
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

	private async handleRow(row: JournalRow) {
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

		await this.containers[containerId].hook({ message, isStdErr, timestamp });
		this.lastSentTimestamp = timestamp;
	}

	private async handleSystemRow(
		row: JournalRow,
		logFn: (
			message: string,
			eventObj?: Dictionary<any> | null,
			eventName?: string,
			track?: boolean,
		) => void,
	) {
		const message = messageFieldToString(row.MESSAGE);
		if (message == null) {
			return;
		}
		const timestamp = Math.floor(Number(row.__REALTIME_TIMESTAMP) / 1000); // microseconds to milliseconds

		await logFn(message, null, 'System service config', false);
		this.lastSentTimestamp = timestamp;
	}
}

const logMonitor = new LogMonitor();

export default logMonitor;
