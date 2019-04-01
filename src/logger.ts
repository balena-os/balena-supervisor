import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import { EventTracker } from './event-tracker';
import Docker from './lib/docker-utils';
import { LogType } from './lib/log-types';
import { writeLock } from './lib/update-lock';
import {
	BalenaLogBackend,
	ContainerLogs,
	LocalLogBackend,
	LogBackend,
	LogMessage,
} from './logging';

interface LoggerSetupOptions {
	apiEndpoint: string;
	uuid: string;
	deviceApiKey: string;
	unmanaged: boolean;
	enableLogs: boolean;
	localMode: boolean;
}

type LogEventObject = Dictionary<any> | null;

interface LoggerConstructOptions {
	eventTracker: EventTracker;
}

export class Logger {
	private backend: LogBackend | null = null;
	private balenaBackend: BalenaLogBackend | null = null;
	private localBackend: LocalLogBackend | null = null;

	private eventTracker: EventTracker;
	private containerLogs: { [containerId: string]: ContainerLogs } = {};

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
		track: boolean = true,
	) {
		const msgObj: LogMessage = { message, isSystem: true };
		if (eventObj != null && eventObj.error != null) {
			msgObj.isStdErr = true;
		}
		this.log(msgObj);
		if (track) {
			this.eventTracker.track(
				eventName != null ? eventName : message,
				eventObj != null ? eventObj : {},
			);
		}
	}

	public lock(containerId: string): Bluebird.Disposer<() => void> {
		return writeLock(containerId).disposer(release => {
			release();
		});
	}

	public attach(
		docker: Docker,
		containerId: string,
		serviceInfo: { serviceId: number; imageId: number },
	): Bluebird<void> {
		// First detect if we already have an attached log stream
		// for this container
		if (containerId in this.containerLogs) {
			return Bluebird.resolve();
		}

		return Bluebird.using(this.lock(containerId), () => {
			const logs = new ContainerLogs(containerId, docker);
			this.containerLogs[containerId] = logs;
			logs.on('error', err => {
				console.error(`Container log retrieval error: ${err}`);
				delete this.containerLogs[containerId];
			});
			logs.on('log', logMessage => {
				this.log(_.merge({}, serviceInfo, logMessage));
			});
			logs.on('closed', () => delete this.containerLogs[containerId]);
			return logs.attach();
		});
	}

	public logSystemEvent(
		logType: LogType,
		obj: LogEventObject,
		track: boolean = true,
	): void {
		let message = logType.humanName;
		const objectName = this.objectNameForLogs(obj);
		if (objectName != null) {
			message += ` '${objectName}'`;
		}
		if (obj && obj.error != null) {
			let errorMessage = obj.error.message;
			if (_.isEmpty(errorMessage)) {
				errorMessage =
					obj.error.name !== 'Error' ? obj.error.name : 'Unknown cause';
				console.error('Warning: invalid error message', obj.error);
			}
			message += ` due to '${errorMessage}'`;
		}
		this.logSystemMessage(message, obj, logType.eventName, track);
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
}

export default Logger;
