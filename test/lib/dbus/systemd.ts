import * as DBus from 'dbus';
import { createSystemInterface } from './utils';

const systemdService = DBus.registerService(
	'system',
	'org.freedesktop.systemd1',
);

// Create the systemd
const systemd = createSystemInterface(
	systemdService,
	'/org/freedesktop/systemd1',
	'org.freedesktop.systemd1.Manager',
);

type Unit = {
	running: boolean;
	path: string;
	partOf?: string;
};

// Maintain the state of created units in memory
const units: { [key: string]: Unit } = {};
function createUnit(name: string, path: string, partOf?: string) {
	// Each unit needs an object and a properties interface
	const obj = systemdService.createObject(path);
	const iface = obj.createInterface('org.freedesktop.DBus.Properties');

	units[name] = { running: false, path, partOf };

	// org.freedesktop.DBus.Properties needs a Get method to get the
	// unit properties
	iface.addMethod(
		'Get',
		{
			in: [
				{ type: 's', name: 'interface_name' },
				{ type: 's', name: 'property_name' },
			],
			out: { type: 'v' },
		} as any,
		function (interfaceName, propertyName, callback: any) {
			if (interfaceName !== 'org.freedesktop.systemd1.Unit') {
				callback(`Unkown interface: ${interfaceName}`);
			}

			switch (propertyName) {
				case 'ActiveState':
					callback(null, units[name].running ? 'active' : 'inactive');
					break;
				case 'PartOf':
					callback(partOf ?? 'none');
					break;
				default:
					callback(`Unknown property: ${propertyName}`);
			}
		},
	);

	iface.update();
}

systemd.addMethod(
	'StopUnit',
	{
		in: [
			{ type: 's', name: 'unit_name' },
			{ type: 's', name: 'mode' },
		],
		out: { type: 'o' },
	} as any,
	function (unitName, _mode, callback: any) {
		if (!units[unitName]) {
			callback(`Unit not found: ${unitName}`);
			return;
		}

		// Wait a bit before changing the runtime state
		setTimeout(() => {
			units[unitName] = { ...units[unitName], running: false };
		}, 500);

		callback(
			null,
			`/org/freedesktop/systemd1/job/${String(
				Math.floor(Math.random() * 10000),
			)}`,
		);
	},
);

systemd.addMethod(
	'StartUnit',
	{
		in: [
			{ type: 's', name: 'unit_name' },
			{ type: 's', name: 'mode' },
		],
		out: { type: 'o' },
	} as any,
	function (unitName, _mode, callback: any) {
		if (!units[unitName]) {
			callback(`Unit not found: ${unitName}`);
			return;
		}

		// Wait a bit before changing the runtime state
		setTimeout(() => {
			units[unitName] = { ...units[unitName], running: true };
		}, 500);

		callback(
			null,
			// Make up a job number
			`/org/freedesktop/systemd1/job/${String(
				Math.floor(Math.random() * 10000),
			)}`,
		);
	},
);

systemd.addMethod(
	'RestartUnit',
	{
		in: [
			{ type: 's', name: 'unit_name' },
			{ type: 's', name: 'mode' },
		],
		out: { type: 'o' },
	} as any,
	function (unitName, _mode, callback: any) {
		if (!units[unitName]) {
			callback(`Unit not found: ${unitName}`);
			return;
		}

		// Wait a bit before changing the runtime state
		setTimeout(() => {
			units[unitName] = { ...units[unitName], running: false };
		}, 500);

		setTimeout(() => {
			units[unitName] = { ...units[unitName], running: true };
		}, 1000);

		callback(
			null,
			`/org/freedesktop/systemd1/job/${String(
				Math.floor(Math.random() * 10000),
			)}`,
		);
	},
);

systemd.addMethod(
	'GetUnit',
	{ in: [{ type: 's', name: 'unit_name' }], out: { type: 'o' } } as any,
	function (unitName, callback) {
		if (!units[unitName]) {
			callback(`Unit not found: ${unitName}`);
			return;
		}

		const { path } = units[unitName];
		callback(null, path);
	},
);

// Simulate OS units
createUnit('openvpn.service', '/org/freedesktop/systemd1/unit/openvpn');
createUnit('avahi.socket', '/org/freedesktop/systemd1/unit/avahi');

systemd.update();
