import * as config from '../config';
import * as dbus from './dbus';

import * as _ from 'lodash';

import log from './supervisor-console';

export const initialized = _.once(async () => {
	await config.initialized();

	config.on('change', (conf) => {
		if (conf.hostDiscoverability != null) {
			void switchDiscoverability(conf.hostDiscoverability);
		}
	});

	await switchDiscoverability(await config.get('hostDiscoverability'));
});

async function switchDiscoverability(discoverable: boolean) {
	try {
		if (discoverable) {
			log.info('Setting host to discoverable');
			await dbus.startService('avahi-daemon');
			await dbus.startSocket('avahi-daemon');
		} else {
			log.info('Setting host to undiscoverable');
			await dbus.stopService('avahi-daemon');
			await dbus.stopSocket('avahi-daemon');
		}
	} catch (e) {
		log.error('There was an error switching host discoverability:', e);
	}
}
