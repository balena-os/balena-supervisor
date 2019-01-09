import * as Bluebird from 'bluebird';
import * as dbus from 'dbus-native';

const bus = dbus.systemBus();
const invokeAsync = Bluebird.promisify(bus.invoke).bind(bus);

const defaultPathInfo = {
	path: '/org/freedesktop/systemd1',
	destination: 'org.freedesktop.systemd1',
	interface: 'org.freedesktop.systemd1.Manager',
};

const systemdManagerMethodCall = (
	method: string,
	signature?: string,
	body?: any[],
	pathInfo: {
		path: string;
		destination: string;
		interface: string;
	} = defaultPathInfo,
) => {
	if (signature == null) {
		signature = '';
	}
	if (body == null) {
		body = [];
	}
	return invokeAsync({
		...pathInfo,
		member: method,
		signature,
		body,
	});
};

export function restartService(serviceName: string) {
	return systemdManagerMethodCall('RestartUnit', 'ss', [
		`${serviceName}.service`,
		'fail',
	]);
}

export function startService(serviceName: string) {
	return systemdManagerMethodCall('StartUnit', 'ss', [
		`${serviceName}.service`,
		'fail',
	]);
}

export function stopService(serviceName: string) {
	return systemdManagerMethodCall('StopUnit', 'ss', [
		`${serviceName}.service`,
		'fail',
	]);
}

export function enableService(serviceName: string) {
	return systemdManagerMethodCall('EnableUnitFiles', 'asbb', [
		[`${serviceName}.service`],
		false,
		false,
	]);
}

export function disableService(serviceName: string) {
	return systemdManagerMethodCall('DisableUnitFiles', 'asb', [
		[`${serviceName}.service`],
		false,
	]);
}

export const reboot = Bluebird.method(() =>
	setTimeout(
		() =>
			systemdManagerMethodCall('Reboot', 'b', [false], {
				path: '/org/freedesktop/login1',
				destination: 'org.freedesktop.login1',
				interface: 'org.freedesktop.login1.Manager',
			}),
		1000,
	),
);

export const shutdown = Bluebird.method(() =>
	setTimeout(
		() =>
			systemdManagerMethodCall('PowerOff', 'b', [false], {
				path: '/org/freedesktop/login1',
				destination: 'org.freedesktop.login1',
				interface: 'org.freedesktop.login1.Manager',
			}),
		1000,
	),
);

function getUnitProperty(unitName: string, property: string) {
	return systemdManagerMethodCall('GetUnit', 's', [unitName])
		.then((unitPath: string) =>
			invokeAsync({
				path: unitPath,
				destination: 'org.freedesktop.systemd1',
				interface: 'org.freedesktop.DBus.Properties',
				member: 'Get',
				signature: 'ss',
				body: ['org.freedesktop.systemd1.Unit', property],
			}),
		)
		.get(1)
		.get(0);
}

export function serviceActiveState(serviceName: string) {
	return getUnitProperty(`${serviceName}.service`, 'ActiveState');
}
