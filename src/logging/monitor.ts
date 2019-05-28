import Database from '../db';

// Flush every 10 mins
const DB_FLUSH_INTERVAL = 10 * 60 * 1000;

/**
 * This class provides a wrapper around the database for
 * saving the last timestamp of a container
 */
export class LogMonitor {
	private timestamps: { [containerId: string]: number } = {};
	private writeRequired: { [containerId: string]: boolean } = {};

	public constructor(private db: Database) {
		setInterval(() => this.flushDb(), DB_FLUSH_INTERVAL);
	}

	public updateContainerSentTimestamp(
		containerId: string,
		timestamp: number,
	): void {
		this.timestamps[containerId] = timestamp;
		this.writeRequired[containerId] = true;
	}

	public async getContainerSentTimestamp(containerId: string): Promise<number> {
		// If this is the first time we are requesting the
		// timestamp for this container, request it from the db
		if (this.timestamps[containerId] == null) {
			// Set the timestamp to 0 before interacting with the
			// db to avoid multiple db actions at once
			this.timestamps[containerId] = 0;
			try {
				const timestampObj = await this.db
					.models('containerLogs')
					.select('lastSentTimestamp')
					.where({ containerId });

				if (timestampObj == null) {
					// Create a row in the db so there's something to
					// update
					await this.db
						.models('containerLogs')
						.insert({ containerId, lastSentTimestamp: 0 });
				} else {
					this.timestamps[containerId] = timestampObj.lastSentTimestamp;
				}
			} catch (e) {
				console.error(
					`There was an error retrieving the container log timestamps: ${e}`,
				);
			}
		}
		return this.timestamps[containerId] || 0;
	}

	private async flushDb() {
		console.log('Attempting container log timestamp flush...');
		const containerIds = Object.getOwnPropertyNames(this.timestamps);
		try {
			for (const containerId of containerIds) {
				// Avoid writing to the db if we don't need to
				if (!this.writeRequired[containerId]) {
					continue;
				}

				await this.db
					.models('containerLogs')
					.where({ containerId })
					.update({ lastSentTimestamp: this.timestamps[containerId] });
				this.writeRequired[containerId] = false;
			}
		} catch (e) {
			console.error(
				`There was an error storing the container log timestamps: ${e}`,
			);
		}
		console.log('Container log timestamp flush complete');
	}
}

export default LogMonitor;
