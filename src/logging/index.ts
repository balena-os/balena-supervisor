import _ from 'lodash';

import * as config from '../config';
import * as eventTracker from '../event-tracker';
import type { LogType } from '../lib/log-types';
import { BalenaLogBackend } from './balena-backend';
import { LocalLogBackend } from './local-backend';
import type { LogBackend } from './log-backend';
import type { LogMessage } from './types';
import logMonitor from './monitor';

import * as globalEventBus from '../event-bus';
import superConsole from '../lib/supervisor-console';

type LogEventObject = Dictionary<any> | null;

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

	logMonitor.attachSystemLogger(log);

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
					conf.uuid ?? '',
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

export function enable(value = true) {
	if (backend != null) {
		backend.publishEnabled = value;
	}
}

export async function log(message: LogMessage) {
	await backend?.log(message);
}

export function logSystemMessage(
	message: string,
	eventObj?: LogEventObject,
	eventName?: string,
	track = true,
) {
	const msgObj: LogMessage = { message, isSystem: true, timestamp: Date.now() };
	if (eventObj?.error != null) {
		msgObj.isStdErr = true;
	}
	// IMPORTANT: this could potentially create a memory leak if logSystemMessage
	// is used too quickly but we don't want supervisor logging to hold up other tasks
	void log(msgObj);
	if (track) {
		eventTracker.track(eventName ?? message, eventObj ?? {});
	}
}

type ServiceInfo = { serviceId: number };
export function attach(containerId: string, { serviceId }: ServiceInfo): void {
	// First detect if we already have an attached log stream
	// for this container
	if (logMonitor.isAttached(containerId)) {
		return;
	}

	// We do not grab a container lock here as we are only adding it to the list of container ids to monitor
	// and not directly affecting the container itself, and grabbing the lock can cause a delay which means
	// that early messages logged from the container are missed and never sent to the backend.
	logMonitor.attach(containerId, async (message) => {
		await log({ ...message, serviceId });
	});
}

export function logSystemEvent(
	logType: LogType,
	obj: LogEventObject,
	track = true,
): void {
	let message = logType.humanName;
	const objectName = objectNameForLogs(obj);
	if (objectName != null) {
		message += ` '${objectName}'`;
	}
	if (obj?.error != null) {
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

function objectNameForLogs(eventObj: LogEventObject): string | null {
	if (eventObj == null) {
		return null;
	}
	if (
		eventObj.service?.serviceName != null &&
		eventObj.service.config?.image != null
	) {
		return `${eventObj.service.serviceName} ${eventObj.service.config.image}`;
	}

	if (eventObj.image != null) {
		return eventObj.image.name;
	}

	if (eventObj.network?.name != null) {
		return eventObj.network.name;
	}

	if (eventObj.volume?.name != null) {
		return eventObj.volume.name;
	}

	if (eventObj.fields != null) {
		return eventObj.fields.join(',');
	}

	return null;
}
