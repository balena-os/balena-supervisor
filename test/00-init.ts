process.env.ROOT_MOUNTPOINT = './test/data';
process.env.BOOT_MOUNTPOINT = '/mnt/boot';
process.env.CONFIG_JSON_PATH = '/config.json';
process.env.DATABASE_PATH = './test/data/database.sqlite';
process.env.DATABASE_PATH_2 = './test/data/database2.sqlite';
process.env.DATABASE_PATH_3 = './test/data/database3.sqlite';
process.env.LED_FILE = './test/data/led_file';

import './lib/mocked-iptables';
import './lib/mocked-event-tracker';

import * as dbus from 'dbus';
import { DBusError, DBusInterface } from 'dbus';
import { stub } from 'sinon';
import * as fs from 'fs';

// Make sure they are no database files left over from
// previous runs
try {
	fs.unlinkSync(process.env.DATABASE_PATH);
} catch {
	/* noop */
}
try {
	fs.unlinkSync(process.env.DATABASE_PATH_2);
} catch {
	/* noop */
}
try {
	fs.unlinkSync(process.env.DATABASE_PATH_3);
} catch {
	/* noop */
}
fs.writeFileSync(
	'./test/data/config.json',
	fs.readFileSync('./test/data/testconfig.json'),
);

stub(dbus, 'getBus').returns({
	getInterface: (
		_serviceName: string,
		_objectPath: string,
		_interfaceName: string,
		interfaceCb: (err: null | DBusError, iface: DBusInterface) => void,
	) => {
		interfaceCb(null, {
			Get: (
				_unitName: string,
				_property: string,
				getCb: (err: null | Error, value: unknown) => void,
			) => {
				getCb(null, 'this is the value');
			},
			GetUnit: (
				_unitName: string,
				getUnitCb: (err: null | Error, unitPath: string) => void,
			) => {
				getUnitCb(null, 'this is the unit path');
			},
		} as any);
	},
} as any);
