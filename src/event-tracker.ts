import mask from 'json-mask';
import _ from 'lodash';

import log from './lib/supervisor-console';

export type EventTrackProperties = Dictionary<any>;

const mixpanelMask = [
	'appId',
	'delay',
	'error',
	'interval',
	'image',
	'app(appId,name)',
	'service(appId,serviceId,serviceName,commit,releaseId,image,labels)',
	'stateDiff/local(os_version,supervisor_version,ip_address,apps/*/services)',
].join(',');

export async function track(
	event: string,
	properties: EventTrackProperties | Error = {},
) {
	if (properties instanceof Error) {
		properties = { error: properties };
	}

	properties = _.cloneDeep(properties);
	if (properties.error instanceof Error) {
		// Format the error for printing, to avoid display as { }
		properties.error = {
			message: properties.error.message,
			stack: properties.error.stack,
		};
	}

	// Don't send potentially sensitive information, by using a whitelist
	properties = mask(properties, mixpanelMask);
	log.event('Event:', event, JSON.stringify(properties));
}
