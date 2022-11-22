import { getBus, Error as DBusError } from 'dbus';
import { promisify } from 'util';
import { TypedError } from 'typed-error';
import _ from 'lodash';

import log from './supervisor-console';
import DBus from 'dbus';

export class DbusError extends TypedError {}

let bus: DBus.DBusConnection;
let getInterfaceAsync: <T = DBus.AnyInterfaceMethod>(
	serviceName: string,
	objectPath: string,
	ifaceName: string,
) => Promise<DBus.DBusInterface<T>>;

export const initialized = _.once(async () => {
	bus = getBus('system');
	getInterfaceAsync = promisify(bus.getInterface.bind(bus));
});

async function getSystemdInterface() {
	await initialized();
	try {
		return await getInterfaceAsync(
			'org.freedesktop.systemd1',
			'/org/freedesktop/systemd1',
			'org.freedesktop.systemd1.Manager',
		);
	} catch (e) {
		throw new DbusError(e as DBusError);
	}
}

async function getLoginManagerInterface() {
	await initialized();
	try {
		return await getInterfaceAsync(
			'org.freedesktop.login1',
			'/org/freedesktop/login1',
			'org.freedesktop.login1.Manager',
		);
	} catch (e) {
		throw new DbusError(e as DBusError);
	}
}

async function startUnit(unitName: string) {
	const systemd = await getSystemdInterface();
	log.debug(`Starting systemd unit: ${unitName}`);
	try {
		systemd.StartUnit(unitName, 'fail');
	} catch (e) {
		throw new DbusError(e as DBusError);
	}
}

export async function restartService(serviceName: string) {
	const systemd = await getSystemdInterface();
	log.debug(`Restarting systemd service: ${serviceName}`);
	try {
		systemd.RestartUnit(`${serviceName}.service`, 'fail');
	} catch (e) {
		throw new DbusError(e as DBusError);
	}
}

export async function startService(serviceName: string) {
	return startUnit(`${serviceName}.service`);
}

export async function startSocket(socketName: string) {
	return startUnit(`${socketName}.socket`);
}

async function stopUnit(unitName: string) {
	const systemd = await getSystemdInterface();
	log.debug(`Stopping systemd unit: ${unitName}`);
	try {
		systemd.StopUnit(unitName, 'fail');
	} catch (e) {
		throw new DbusError(e as DBusError);
	}
}

export async function stopService(serviceName: string) {
	return stopUnit(`${serviceName}.service`);
}

export async function stopSocket(socketName: string) {
	return stopUnit(`${socketName}.socket`);
}

export const reboot = async () =>
	setTimeout(async () => {
		try {
			const logind = await getLoginManagerInterface();
			logind.Reboot(false);
		} catch (e) {
			log.error(`Unable to reboot: ${e}`);
		}
	}, 1000);

export const shutdown = async () =>
	setTimeout(async () => {
		try {
			const logind = await getLoginManagerInterface();
			logind.PowerOff(false);
		} catch (e) {
			log.error(`Unable to shutdown: ${e}`);
		}
	}, 1000);

async function getUnitProperty(
	unitName: string,
	property: string,
): Promise<string> {
	const systemd = await getSystemdInterface();
	return new Promise((resolve, reject) => {
		systemd.GetUnit(unitName, async (err: Error, unitPath: string) => {
			if (err) {
				return reject(err);
			}
			const iface = await getInterfaceAsync(
				'org.freedesktop.systemd1',
				unitPath,
				'org.freedesktop.DBus.Properties',
			);

			iface.Get(
				'org.freedesktop.systemd1.Unit',
				property,
				(e: Error, value: string) => {
					if (e) {
						return reject(new DbusError(e));
					}
					resolve(value);
				},
			);
		});
	});
}

export function serviceActiveState(serviceName: string) {
	return getUnitProperty(`${serviceName}.service`, 'ActiveState');
}

export function servicePartOf(serviceName: string) {
	return getUnitProperty(`${serviceName}.service`, 'PartOf');
}
