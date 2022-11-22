import * as es from 'event-stream';
import { EventEmitter } from 'events';
import _ from 'lodash';
import * as Stream from 'stream';
import StrictEventEmitter from 'strict-event-emitter-types';

import { docker } from '../lib/docker-utils';

export interface ContainerLog {
	message: string;
	timestamp: number;
	isStdout: boolean;
}

interface LogsEvents {
	log: ContainerLog;
	closed: void;
	error: Error;
}

type LogsEventEmitter = StrictEventEmitter<EventEmitter, LogsEvents>;

export class ContainerLogs extends (EventEmitter as new () => LogsEventEmitter) {
	public constructor(public containerId: string) {
		super();
	}

	public async attach(lastSentTimestamp: number) {
		const logOpts = {
			follow: true,
			timestamps: true,
			since: Math.floor(lastSentTimestamp / 1000),
		};
		const stdoutLogOpts = { stdout: true, stderr: false, ...logOpts };
		const stderrLogOpts = { stderr: true, stdout: false, ...logOpts };

		const container = docker.getContainer(this.containerId);
		const stdoutStream = await container.logs(stdoutLogOpts);
		const stderrStream = await container.logs(stderrLogOpts);

		[
			[stdoutStream, true],
			[stderrStream, false],
		].forEach(([stream, isStdout]: [Stream.Readable, boolean]) => {
			stream
				.on('error', (err) => {
					this.emit(
						'error',
						new Error(`Error on container logs: ${err} ${err.stack}`),
					);
				})
				.pipe(es.split())
				.on('data', (logBuf: Buffer | string) => {
					if (_.isString(logBuf)) {
						logBuf = Buffer.from(logBuf);
					}
					const logMsg = ContainerLogs.extractMessage(logBuf);
					if (logMsg != null) {
						this.emit('log', { isStdout, ...logMsg });
					}
				})
				.on('error', (err) => {
					this.emit(
						'error',
						new Error(`Error on container logs: ${err} ${err.stack}`),
					);
				})
				.on('end', () => this.emit('closed'));
		});
	}

	private static extractMessage(
		msgBuf: Buffer,
	): { message: string; timestamp: number } | undefined {
		// Non-tty message format from:
		// https://docs.docker.com/engine/api/v1.30/#operation/ContainerAttach
		if (
			_.includes([0, 1, 2], msgBuf[0]) &&
			_.every(msgBuf.slice(1, 7), (c) => c === 0)
		) {
			// Take the header from this message, and parse it as normal
			msgBuf = msgBuf.slice(8);
		}
		const logLine = msgBuf.toString();
		const space = logLine.indexOf(' ');
		if (space > 0) {
			let timestamp = new Date(logLine.substr(0, space)).getTime();
			if (_.isNaN(timestamp)) {
				timestamp = Date.now();
			}
			return {
				timestamp,
				message: logLine.substr(space + 1),
			};
		}
		return;
	}
}

export default ContainerLogs;
