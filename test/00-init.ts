process.env.ROOT_MOUNTPOINT = './test/data';
process.env.BOOT_MOUNTPOINT = '/mnt/boot';
process.env.CONFIG_JSON_PATH = '/config.json';
process.env.DATABASE_PATH = './test/data/database.sqlite';
process.env.DATABASE_PATH_2 = './test/data/database2.sqlite';
process.env.DATABASE_PATH_3 = './test/data/database3.sqlite';
process.env.LED_FILE = './test/data/led_file';

import { stub } from 'sinon';

import * as dbus from 'dbus';

// Stub the dbus objects to dynamically generate the methods
// on request
stub(dbus, 'getBus').returns({
	getInterface: (
		_obj: unknown,
		cb: (err: Error | undefined, iface: dbus.DBusInterface) => void,
	) => {
		return cb(
			undefined,
			new Proxy(
				{},
				{
					get(_target, name) {
						console.log(`Dbus method ${String(name)} requested`);
						return () => {
							/* noop */
						};
					},
				},
			) as any,
		);
	},
} as any);
