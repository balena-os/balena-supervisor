import * as Bluebird from 'bluebird';
import mask = require('json-mask');
import * as _ from 'lodash';
import * as memoizee from 'memoizee';

import Mixpanel = require('mixpanel');

import { ConfigType } from './config';
import log from './lib/supervisor-console';
import supervisorVersion = require('./lib/supervisor-version');

export type EventTrackProperties = Dictionary<any>;

interface InitArgs {
	uuid: ConfigType<'uuid'>;
	unmanaged: ConfigType<'unmanaged'>;
	mixpanelHost: ConfigType<'mixpanelHost'>;
	mixpanelToken: ConfigType<'mixpanelToken'>;
}

// The minimum amount of time to wait between sending
// events of the same type
const eventDebounceTime = 60000;

const mixpanelMask = [
	'appId',
	'delay',
	'error',
	'interval',
	'image',
	'app(appId,name)',
	'service(appId,serviceId,serviceName,commit,releaseId,image,labels)',
	'stateDiff/local(os_version,superisor_version,ip_address,apps/*/services)',
].join(',');

export class EventTracker {
	private defaultProperties: EventTrackProperties | null;
	private client: any;

	public constructor() {
		this.client = null;
		this.defaultProperties = null;
	}

	public init({
		unmanaged,
		mixpanelHost,
		mixpanelToken,
		uuid,
	}: InitArgs): Bluebird<void> {
		return Bluebird.try(() => {
			this.defaultProperties = {
				distinct_id: uuid,
				uuid,
				supervisorVersion,
			};
			if (unmanaged || mixpanelHost == null) {
				return;
			}
			this.client = Mixpanel.init(mixpanelToken, {
				host: mixpanelHost.host,
				path: mixpanelHost.path,
			});
		});
	}

	public track(event: string, properties: EventTrackProperties | Error = {}) {
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
		this.logEvent('Event:', event, JSON.stringify(properties));
		if (this.client == null) {
			return;
		}

		properties = this.assignDefaultProperties(properties);
		this.throttleddLogger(event)(properties);
	}

	private throttleddLogger = memoizee(
		(event: string) => {
			// Call this function at maximum once every minute
			return _.throttle(
				properties => {
					this.client.track(event, properties);
				},
				eventDebounceTime,
				{ leading: true },
			);
		},
		{ primitive: true },
	);

	private logEvent(...args: string[]) {
		log.event(...args);
	}

	private assignDefaultProperties(
		properties: EventTrackProperties,
	): EventTrackProperties {
		return _.merge({}, properties, this.defaultProperties);
	}
}

export default EventTracker;
