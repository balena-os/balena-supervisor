import * as dbus from 'dbus';
import { Error as DBusError, DBusInterface } from 'dbus';
import { stub } from 'sinon';

/**
 * Because lib/dbus invokes dbus.getBus on module import,
 * getBus needs to be stubbed at the root level due how JS
 * `require` works. lib/dbus interfaces with the systemd and
 * logind interfaces, which expose the unit methods below.
 *
 * There should be no need to un-stub dbus.getBus at any point
 * during testing, since we never want to interact with the actual
 * dbus system socket in the test environment.
 *
 * To test interaction with lib/dbus, import lib/dbus into the test suite
 * and stub the necessary methods, as you would with any other module.
 */
stub(dbus, 'getBus').returns({
	getInterface: (
		serviceName: string,
		_objectPath: string,
		_interfaceName: string,
		interfaceCb: (err: null | DBusError, iface: DBusInterface) => void,
	) => {
		if (/systemd/.test(serviceName)) {
			interfaceCb(null, {
				StartUnit: () => {
					// noop
				},
				RestartUnit: () => {
					// noop
				},
				StopUnit: () => {
					// noop
				},
				EnableUnitFiles: () => {
					// noop
				},
				DisableUnitFiles: () => {
					// noop
				},
				GetUnit: (
					_unitName: string,
					getUnitCb: (err: null | Error, unitPath: string) => void,
				) => {
					getUnitCb(null, 'this is the unit path');
				},
				Get: (
					_unitName: string,
					_property: string,
					getCb: (err: null | Error, value: unknown) => void,
				) => {
					getCb(null, 'this is the value');
				},
			} as any);
		} else {
			interfaceCb(null, {
				Reboot: () => {
					// noop
				},
				PowerOff: () => {
					// noop
				},
			} as any);
		}
	},
} as dbus.DBusConnection);
