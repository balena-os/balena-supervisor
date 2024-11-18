import { pipeline } from 'stream/promises';
import { setTimeout } from 'timers/promises';

import { spawnJournalctl, toJournalDate } from '../lib/journald';
import log from '../lib/supervisor-console';
import type { SystemLogMessage, BaseLogMessage } from './types';

type MonitorHook = (message: BaseLogMessage) => Promise<void>;
type SystemMonitorHook = (message: SystemLogMessage) => Promise<void>;

// This is nowhere near the amount of fields provided by journald, but simply the ones
// that we are interested in
interface JournalRow {
	CONTAINER_ID_FULL?: string;
	CONTAINER_NAME?: string;
	MESSAGE: string | number[];
	PRIORITY: string;
	__REALTIME_TIMESTAMP: string;
	_SYSTEMD_UNIT: string;
}

// Wait 5s when journalctl failed before trying to read the logs again
const JOURNALCTL_ERROR_RETRY_DELAY = 5000;
const JOURNALCTL_ERROR_RETRY_DELAY_MAX = 15 * 60 * 1000;

// Additional host services we want to stream the logs for
const HOST_SERVICES = [
	// Balena service which applies power mode to config file on boot
	'os-power-mode.service',
	// Balena service which applies fan profile to device at runtime
	'os-fan-profile.service',
	// Nvidia power daemon which logs result from applying power mode from config file to device
	'nvpmodel.service',
	// Runs at boot time and checks if Orin QSPI is accessible after provisioning
	'jetson-qspi-manager.service',
];

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

/**
 * Streams logs from journalctl and calls container hooks when a record is received matching container id
 */
class LogMonitor {
	private containers: {
		[containerId: string]: {
			hook: MonitorHook;
		};
	} = {};
	private systemHook: SystemMonitorHook = async () => {
		/* Default empty hook */
	};
	private setupAttempts = 0;

	// Only stream logs since the start of the supervisor
	private lastSentTimestamp = Date.now() - performance.now();

	public async start(): Promise<void> {
		try {
			// TODO: do not spawn journalctl if logging is not enabled
			const { stdout, stderr } = spawnJournalctl({
				all: true,
				follow: true,
				format: 'json',
				filter: [
					// Monitor logs from balenad by default for container log-streaming
					'balena.service',
					// Add any host services we want to stream
					...HOST_SERVICES,
				].map((s) => `_SYSTEMD_UNIT=${s}`),
				since: toJournalDate(this.lastSentTimestamp),
			});
			if (!stdout) {
				// This error will be caught below
				throw new Error('failed to open process stream');
			}

			stderr?.on('data', (data) =>
				log.error('Journalctl process stderr: ', data.toString()),
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
						} else if (HOST_SERVICES.includes(row._SYSTEMD_UNIT)) {
							await self.handleHostServiceRow(row);
						}
					} catch {
						// ignore parsing errors
					}
				}
			});
			log.debug('Journalctl process exit.');
		} catch (e: any) {
			log.error('Journalctl process error: ', e.message ?? e);
		}

		// On exit of process try to create another
		const wait = Math.min(
			2 ** this.setupAttempts++ * JOURNALCTL_ERROR_RETRY_DELAY,
			JOURNALCTL_ERROR_RETRY_DELAY_MAX,
		);
		log.debug(
			`Spawning another process to watch journal logs in ${wait / 1000}s`,
		);
		await setTimeout(wait);
		void this.start();
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

	public attachSystemLogger(hook: SystemMonitorHook) {
		this.systemHook = hook;
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
		const isStdErr = parseInt(row.PRIORITY, 10) <= 3;
		const timestamp = Math.floor(Number(row.__REALTIME_TIMESTAMP) / 1000); // microseconds to milliseconds

		await this.containers[containerId].hook({
			message,
			isStdErr,
			timestamp,
		});
		this.lastSentTimestamp = timestamp;
	}

	private async handleHostServiceRow(
		row: JournalRow & { _SYSTEMD_UNIT: string },
	) {
		const message = messageFieldToString(row.MESSAGE);
		if (message == null) {
			return;
		}
		const isStdErr = parseInt(row.PRIORITY, 10) <= 3;
		const timestamp = Math.floor(Number(row.__REALTIME_TIMESTAMP) / 1000); // microseconds to milliseconds
		void this.systemHook({
			message,
			isStdErr,
			timestamp,
			isSystem: true,
		});
	}
}

const logMonitor = new LogMonitor();

export default logMonitor;
