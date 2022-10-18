// TODO: Remove this file when all legacy tests have migrated to unit/integration.

import { stub, SinonStub } from 'sinon';
import * as dbus from 'dbus';
import { Error as DBusError, DBusInterface } from 'dbus';
import { initialized } from '~/src/lib/dbus';

let getBusStub: SinonStub;

export const mochaHooks = {
	async beforeAll() {
		getBusStub = stub(dbus, 'getBus').returns({
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

		// Initialize dbus module before any tests are run so any further tests
		// that interface with lib/dbus use the stubbed busses above.
		await initialized();
	},
	afterAll() {
		getBusStub.restore();
	},
};
