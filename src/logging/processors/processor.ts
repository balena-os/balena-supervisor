/**
 * Processor
 *
 * Provides ability to transform logs into other useful formats.
 *
 * Example: Given an array of logs you can filter out noise
 * Example: Given an array of logs you can compact several logs into single lines
 *
 */

export abstract class Processor {
	/**
	 * Transform the given list of log strings into any
	 *
	 * @param {logs} list of log messages
	 * @returns {any} transformed logs (Example: string[], object[])
	 */
	public abstract process(logs: string[]): any;
}
