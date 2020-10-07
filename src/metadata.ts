import * as constants from './lib/constants';
import * as request from './lib/request';
import { readFileSync, writeFileSync } from 'fs';
import { reboot } from './device-state';
import log from './lib/supervisor-console';

export const initialized = (async () => {
	if (constants.configJsonNonAtomicPath != null) {
		const configJsonPath = constants.configJsonNonAtomicPath;
		const config = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
		if (
			!config.hasOwnProperty('unmanaged') &&
			!config.hasOwnProperty('registered_at') &&
			!config.hasOwnProperty('applicationId') &&
			!config.hasOwnProperty('deviceId')
		) {
			const opts: request.requestLib.CoreOptions = {};

			log.debug('Attempting to initialise from cloud metadata');
			const url = 'http://169.254.169.254/latest/user-data';
			const [res, data] = await (await request.getRequestInstance()).getAsync(
				url,
				opts,
			);

			if (res.statusCode === 200) {
				writeFileSync(configJsonPath, data, 'utf-8');
				reboot(true, true);
			}
		} else {
			log.debug('Device already provisioned.');
		}
	}
})();
