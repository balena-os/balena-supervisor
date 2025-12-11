import { pipeline } from 'stream/promises';
import { setTimeout } from 'timers/promises';
import type { ContainerInspectInfo } from 'dockerode';

import { spawnJournalctl, toJournalDate } from '../lib/journald';
import log from '../lib/supervisor-console';
import { docker } from '../lib/docker-utils';
import type { SpawnJournalctlOpts } from '../lib/journald';
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
	// os-update service which logs status of HUP and update-balena-supervisor
	'os-update.service',
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

const getSupervisorContainer =
	async (): Promise<ContainerInspectInfo | null> => {
		try {
			return await Promise.any([
				docker.getContainer('balena_supervisor').inspect(),
				docker.getContainer('resin_supervisor').inspect(),
			]);
		} catch {
			// If all promises reject, return null
			return null;
		}
	};

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

	// By default, only stream logs since the start of the Supervisor process
	private lastSentTimestamp: number | null = null;

	public async start(): Promise<void> {
		// Get journalctl spawn options
		const opts = await this.getJournalctlOptions();

		// Spawn journalctl process to stream logs
		try {
			// TODO: do not spawn journalctl if logging is not enabled
			const { stdout, stderr } = spawnJournalctl(opts);
			if (!stdout) {
				// This error will be caught below
				throw new Error('failed to open process stream');
			}

			stderr?.on('data', (data) => {
				log.error('Journalctl process stderr: ', data.toString());
			});

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
							self.handleHostServiceRow(row);
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

	private async getJournalctlOptions(): Promise<SpawnJournalctlOpts> {
		// On SV start, journalctl is spawned with a timestamp to only
		// get logs since the last Supervisor State.FinishedAt. This will catch any
		// host and container logs generated while the Supervisor was not running.
		const supervisorContainer = await getSupervisorContainer();
		if (supervisorContainer !== null) {
			const finishedAt = supervisorContainer.State.FinishedAt;
			const finishedAtDate = new Date(finishedAt).getTime();
			// When a container has never exited with any exit code,
			// the FinishedAt timestamp is "0001-01-01T00:00:00Z". Any
			// timestamp below 0 in ms value is from before the epoch.
			// Only set the lastSentTimestamp to the last Supervisor State.FinishedAt if:
			// - finishedAtDate is greater than 0 (i.e. the supervisor container has exited at least once)
			// - lastSentTimestamp is null (i.e. this is the first time we've started the monitor)
			//   - This prevents the case of the logs getting streamed from State.FinishedAt for
			//     subsequent monitor.start() calls due to the underlying journalctl process dying.
			if (finishedAtDate > 0 && this.lastSentTimestamp == null) {
				this.lastSentTimestamp = finishedAtDate;
			}
		}

		// If the conditions weren't met to set the lastSentTimestamp, use the process uptime
		this.lastSentTimestamp ??= Date.now() - performance.now();

		return {
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
		};
	}

	public isAttached(containerId: string): boolean {
		return containerId in this.containers;
	}

	public attach(containerId: string, hook: MonitorHook) {
		this.containers[containerId] ??= {
			hook,
		};
	}

	public detach(containerId: string) {
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

	private handleHostServiceRow(row: JournalRow & { _SYSTEMD_UNIT: string }) {
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
