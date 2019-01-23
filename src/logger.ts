import * as Bluebird from 'bluebird';
import * as es from 'event-stream';
import * as _ from 'lodash';

import { EventTracker } from './event-tracker';
import Docker from './lib/docker-utils';
import { LogType } from './lib/log-types';
import { writeLock } from './lib/update-lock';
import {
	LocalLogBackend,
	LogBackend,
	LogMessage,
	BalenaLogBackend,
} from './logging-backends';

interface LoggerSetupOptions {
	apiEndpoint: string;
	uuid: string;
	deviceApiKey: string;
	unmanaged: boolean;
	enableLogs: boolean;
	localMode: boolean;
}

type LogEventObject = Dictionary<any> | null;

enum OutputStream {
	Stdout,
	Stderr,
}

interface LoggerConstructOptions {
	eventTracker: EventTracker;
}

export class Logger {
	private backend: LogBackend | null = null;
	private balenaBackend: BalenaLogBackend | null = null;
	private localBackend: LocalLogBackend | null = null;

	private eventTracker: EventTracker;
	private attached: {
		[key in OutputStream]: { [containerId: string]: boolean }
	} = {
		[OutputStream.Stderr]: {},
		[OutputStream.Stdout]: {},
	};

	public constructor({ eventTracker }: LoggerConstructOptions) {
		this.backend = null;
		this.eventTracker = eventTracker;
	}

	public init({
		apiEndpoint,
		uuid,
		deviceApiKey,
		unmanaged,
		enableLogs,
		localMode,
	}: LoggerSetupOptions) {
		this.balenaBackend = new BalenaLogBackend(apiEndpoint, uuid, deviceApiKey);
		this.localBackend = new LocalLogBackend();

		this.backend = localMode ? this.localBackend : this.balenaBackend;

		this.backend.unmanaged = unmanaged;
		this.backend.publishEnabled = enableLogs;
	}

	public switchBackend(localMode: boolean) {
		if (localMode) {
			// Use the local mode backend
			this.backend = this.localBackend;
			console.log('Switching logging backend to LocalLogBackend');
		} else {
			// Use the balena backend
			this.backend = this.balenaBackend;
			console.log('Switching logging backend to BalenaLogBackend');
		}
	}

	public getLocalBackend(): LocalLogBackend {
		// TODO: Think about this interface a little better, it would be
		// nicer to proxy the logs via the logger module
		if (this.localBackend == null) {
			// TODO: Type this as an internal inconsistency error
			throw new Error('Local backend logger is not defined.');
		}
		return this.localBackend;
	}

	public enable(value: boolean = true) {
		if (this.backend != null) {
			this.backend.publishEnabled = value;
		}
	}

	public logDependent(message: LogMessage, device: { uuid: string }) {
		if (this.backend != null) {
			message.uuid = device.uuid;
			this.backend.log(message);
		}
	}

	public log(message: LogMessage) {
		if (this.backend != null) {
			this.backend.log(message);
		}
	}

	public logSystemMessage(
		message: string,
		eventObj?: LogEventObject,
		eventName?: string,
	) {
		const msgObj: LogMessage = { message, isSystem: true };
		if (eventObj != null && eventObj.error != null) {
			msgObj.isStdErr = true;
		}
		this.log(msgObj);
		this.eventTracker.track(
			eventName != null ? eventName : message,
			eventObj != null ? eventObj : {},
		);
	}

	public lock(containerId: string): Bluebird.Disposer<() => void> {
		return writeLock(containerId).disposer(release => {
			release();
		});
	}

	public attach(
		docker: Docker,
		containerId: string,
		serviceInfo: { serviceId: string; imageId: string },
	): Bluebird<void> {
		return Bluebird.using(this.lock(containerId), () => {
			return this.attachStream(
				docker,
				OutputStream.Stdout,
				containerId,
				serviceInfo,
			).then(() => {
				return this.attachStream(
					docker,
					OutputStream.Stderr,
					containerId,
					serviceInfo,
				);
			});
		});
	}

	public logSystemEvent(logType: LogType, obj: LogEventObject): void {
		let message = logType.humanName;
		const objectName = this.objectNameForLogs(obj);
		if (objectName != null) {
			message += ` '${objectName}'`;
		}
		if (obj && obj.error != null) {
			let errorMessage = obj.error.message;
			if (_.isEmpty(errorMessage)) {
				errorMessage = 'Unknown cause';
				console.error('Warning: invalid error message', obj.error);
			}
			message += ` due to '${errorMessage}'`;
		}
		this.logSystemMessage(message, obj, logType.eventName);
	}

	public logConfigChange(
		config: { [configName: string]: string },
		{ success = false, err }: { success?: boolean; err?: Error } = {},
	) {
		const obj: LogEventObject = { config };
		let message: string;
		let eventName: string;
		if (success) {
			message = `Applied configuration change ${JSON.stringify(config)}`;
			eventName = 'Apply config change success';
		} else if (err != null) {
			message = `Error applying configuration change: ${err}`;
			eventName = 'Apply config change error';
			obj.error = err;
		} else {
			message = `Applying configuration change ${JSON.stringify(config)}`;
			eventName = 'Apply config change in progress';
		}

		this.logSystemMessage(message, obj, eventName);
	}

	// TODO: This function interacts with the docker daemon directly,
	// using the container id, but it would be better if this was provided
	// by the Compose/Service-Manager module, as an accessor
	private attachStream(
		docker: Docker,
		streamType: OutputStream,
		containerId: string,
		{ serviceId, imageId }: { serviceId: string; imageId: string },
	): Bluebird<void> {
		return Bluebird.try(() => {
			if (this.attached[streamType][containerId]) {
				return;
			}

			const logsOpts = {
				follow: true,
				stdout: streamType === OutputStream.Stdout,
				stderr: streamType === OutputStream.Stderr,
				timestamps: true,
				since: Math.floor(Date.now() / 1000),
			};

			return docker
				.getContainer(containerId)
				.logs(logsOpts)
				.then(stream => {
					this.attached[streamType][containerId] = true;

					stream
						.on('error', err => {
							console.error('Error on container logs', err);
							this.attached[streamType][containerId] = false;
						})
						.pipe(es.split())
						.on('data', (logBuf: Buffer | string) => {
							if (_.isString(logBuf)) {
								logBuf = Buffer.from(logBuf);
							}
							const logMsg = Logger.extractContainerMessage(logBuf);
							if (logMsg != null) {
								const message: LogMessage = {
									message: logMsg.message,
									timestamp: logMsg.timestamp,
									serviceId,
									imageId,
								};
								if (streamType === OutputStream.Stderr) {
									message.isStdErr = true;
								}
								this.log(message);
							}
						})
						.on('error', err => {
							console.error('Error on container logs', err);
							this.attached[streamType][containerId] = false;
						})
						.on('end', () => {
							this.attached[streamType][containerId] = false;
						});
				});
		});
	}

	private objectNameForLogs(eventObj: LogEventObject): string | null {
		if (eventObj == null) {
			return null;
		}
		if (
			eventObj.service != null &&
			eventObj.service.serviceName != null &&
			eventObj.service.config != null &&
			eventObj.service.config.image != null
		) {
			return `${eventObj.service.serviceName} ${eventObj.service.config.image}`;
		}

		if (eventObj.image != null) {
			return eventObj.image.name;
		}

		if (eventObj.network != null && eventObj.network.name != null) {
			return eventObj.network.name;
		}

		if (eventObj.volume != null && eventObj.volume.name != null) {
			return eventObj.volume.name;
		}

		if (eventObj.fields != null) {
			return eventObj.fields.join(',');
		}

		return null;
	}

	private static extractContainerMessage(
		msgBuf: Buffer,
	): { message: string; timestamp: number } | null {
		// Non-tty message format from:
		// https://docs.docker.com/engine/api/v1.30/#operation/ContainerAttach
		if (msgBuf[0] in [0, 1, 2] && _.every(msgBuf.slice(1, 7), c => c === 0)) {
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
		return null;
	}
}

export default Logger;
