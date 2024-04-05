import Bluebird from 'bluebird';
import _ from 'lodash';

import * as config from './config';
import * as db from './db';
import * as eventTracker from './event-tracker';
import type { LogType } from './lib/log-types';
import { takeGlobalLockRW } from './lib/process-lock';
import type { LogBackend, LogMessage } from './logging';
import { BalenaLogBackend, LocalLogBackend } from './logging';
import type { MonitorHook } from './logging/monitor';
import logMonitor from './logging/monitor';

import * as globalEventBus from './event-bus';
import superConsole from './lib/supervisor-console';

type LogEventObject = Dictionary<any> | null;

// export class Logger {
let backend: LogBackend | null = null;
let balenaBackend: BalenaLogBackend | null = null;
let localBackend: LocalLogBackend | null = null;

export const initialized = _.once(async () => {
	await config.initialized();
	const {
		apiEndpoint,
		logsEndpoint,
		uuid,
		deviceApiKey,
		unmanaged,
		loggingEnabled,
		localMode,
	} = await config.getMany([
		'apiEndpoint',
		'logsEndpoint',
		'uuid',
		'deviceApiKey',
		'unmanaged',
		'loggingEnabled',
		'localMode',
	]);

	balenaBackend = new BalenaLogBackend(
		logsEndpoint ?? apiEndpoint,
		uuid,
		deviceApiKey,
	);
	localBackend = new LocalLogBackend();
	backend = localMode ? localBackend : balenaBackend;
	backend.unmanaged = unmanaged;
	backend.publishEnabled = loggingEnabled;

	if (!balenaBackend.isInitialised()) {
		globalEventBus.getInstance().once('deviceProvisioned', async () => {
			const conf = await config.getMany([
				'uuid',
				'apiEndpoint',
				'logsEndpoint',
				'deviceApiKey',
			]);

			// We use Boolean here, as deviceApiKey when unset
			// is '' for legacy reasons. Once we're totally
			// typescript, we can make it have a default value
			// of undefined.
			if (_.every(conf, Boolean)) {
				// Everything is set, provide the values to the
				// balenaBackend, and remove our listener
				balenaBackend!.assignFields(
					conf.logsEndpoint ?? conf.apiEndpoint,
					conf.uuid!,
					conf.deviceApiKey,
				);
			}
		});
	}
});

export function switchBackend(localMode: boolean) {
	if (localMode) {
		// Use the local mode backend
		backend = localBackend;
		superConsole.info('Switching logging backend to LocalLogBackend');
	} else {
		// Use the balena backend
		backend = balenaBackend;
		superConsole.info('Switching logging backend to BalenaLogBackend');
	}
}

export function getLocalBackend(): LocalLogBackend {
	// TODO: Think about this interface a little better, it would be
	// nicer to proxy the logs via the logger module
	if (localBackend == null) {
		// TODO: Type this as an internal inconsistency error
		throw new Error('Local backend logger is not defined.');
	}
	return localBackend;
}

export function enable(value: boolean = true) {
	if (backend != null) {
		backend.publishEnabled = value;
	}
}

export function log(message: LogMessage) {
	backend?.log(message);
}

export function logSystemMessage(
	message: string,
	eventObj?: LogEventObject,
	eventName?: string,
	track: boolean = true,
) {
	const msgObj: LogMessage = { message, isSystem: true };
	if (eventObj != null && eventObj.error != null) {
		msgObj.isStdErr = true;
	}
	log(msgObj);
	if (track) {
		eventTracker.track(
			eventName != null ? eventName : message,
			eventObj != null ? eventObj : {},
		);
	}
}

export function lock(containerId: string): Bluebird.Disposer<() => void> {
	return takeGlobalLockRW(containerId).disposer((release) => {
		release();
	});
}

type ServiceInfo = { serviceId: number; imageId: number };
export function attach(
	containerId: string,
	{ serviceId, imageId }: ServiceInfo,
): Bluebird<void> {
	// First detect if we already have an attached log stream
	// for this container
	if (logMonitor.isAttached(containerId)) {
		return Bluebird.resolve();
	}

	return Bluebird.using(lock(containerId), async () => {
		await logMonitor.attach(
			containerId,
			(message: Parameters<MonitorHook>[0] & Partial<ServiceInfo>) => {
				message.serviceId = serviceId;
				message.imageId = imageId;
				log(message);
			},
		);
	});
}

export function logSystemEvent(
	logType: LogType,
	obj: LogEventObject,
	track: boolean = true,
): void {
	let message = logType.humanName;
	const objectName = objectNameForLogs(obj);
	if (objectName != null) {
		message += ` '${objectName}'`;
	}
	if (obj && obj.error != null) {
		let errorMessage = obj.error.message;
		if (_.isEmpty(errorMessage)) {
			errorMessage =
				obj.error.name !== 'Error' ? obj.error.name : 'Unknown cause';
			superConsole.warn('Invalid error message', obj.error);
		}
		message += ` due to '${errorMessage}'`;
	}
	logSystemMessage(message, obj, logType.eventName, track);
}

export function logConfigChange(
	conf: { [configName: string]: string },
	{ success = false, err }: { success?: boolean; err?: Error } = {},
) {
	const obj: LogEventObject = { conf };
	let message: string;
	let eventName: string;
	if (success) {
		message = `Applied configuration change ${JSON.stringify(conf)}`;
		eventName = 'Apply config change success';
	} else if (err != null) {
		message = `Error applying configuration change: ${err}`;
		eventName = 'Apply config change error';
		obj.error = err;
	} else {
		message = `Applying configuration change ${JSON.stringify(conf)}`;
		eventName = 'Apply config change in progress';
	}

	logSystemMessage(message, obj, eventName);
}

export async function clearOutOfDateDBLogs(containerIds: string[]) {
	superConsole.debug(
		'Performing database cleanup for container log timestamps',
	);
	await db
		.models('containerLogs')
		.whereNotIn('containerId', containerIds)
		.delete();
}

function objectNameForLogs(eventObj: LogEventObject): string | null {
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
