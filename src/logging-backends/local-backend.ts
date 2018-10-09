import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import { Readable } from 'stream';
import { checkInt } from '../lib/validation';
import { LogBackend, LogMessage } from './log-backend';

export class LocalLogBackend extends LogBackend {

	private globalListeners: Readable[] = [];

	private serviceNameResolver: (serviceId: number) => Bluebird<string>;

	public log(message: LogMessage): void {
		if (this.publishEnabled) {

			Bluebird.try(() => {
				if (!message.isSystem) {
					if (this.serviceNameResolver == null) {
						// This means there is no listener assigned, drop the logs
						// TODO: Store these, and resolve them when a listener is attached
						return null;
					}
					const svcId = checkInt(message.serviceId);
					if (svcId == null) {
						console.log('Warning: Non-integer service id found in local logs: ');
						console.log(`   ${JSON.stringify(message)}`);
						return null;
					}
					// TODO: Can we cache this value? The service ids are reused, so
					// we would need a way of invalidating the cache
					return this.serviceNameResolver(svcId).then((serviceName) => {
						return _.assign({}, { serviceName }, message);
					});
				} else {
					return message;
				}
			})
			.then((message: LogMessage | null) => {
				if (message != null) {
					_.each(this.globalListeners, (listener) => {
						listener.push(`${JSON.stringify(message)}\n`);
					});
				}
			})
				.catch((e) => {
					console.log('Error streaming local log output: ', e);
				});
		}
	}

	/**
	 * Get a stream which will be populated with log messages from
	 * local mode services and the supervisor
	 */
	public attachListener(): Readable {
		const stream = new Readable({
			// We don't actually need to do anything here
			read: _.noop,
		});
		this.globalListeners.push(stream);
		return stream;
	}

	public assignServiceNameResolver(resolver: (serviceId: number) => Bluebird<string>) {
		this.serviceNameResolver = resolver;
	}

}

export default LocalLogBackend;
