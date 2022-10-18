import * as DBus from 'dbus';

export function createSystemInterface(
	svc: DBus.DBusService | string,
	objName: string,
	ifaceName: string,
) {
	const service = ((s: DBus.DBusService | string) => {
		if (typeof s === 'string') {
			return DBus.registerService('system', s);
		}
		return s;
	})(svc);

	const obj = service.createObject(objName);
	return obj.createInterface(ifaceName);
}
