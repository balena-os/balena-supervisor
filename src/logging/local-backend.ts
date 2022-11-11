import Bluebird from 'bluebird';
import _ from 'lodash';

import { Readable } from 'stream';
import { checkInt } from '../lib/validation';
import { LogBackend, LogMessage } from './log-backend';

import log from '../lib/supervisor-console';

export class LocalLogBackend extends LogBackend {
	private globalListeners: Readable[] = [];

	private serviceNameResolver: (
		serviceId: number,
	) => Promise<string> | Bluebird<string>;

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
						log.warn(
							'Non-integer service id found in local logs:\n',
							JSON.stringify(message),
						);
						return null;
					}
					// TODO: Can we cache this value? The service ids are reused, so
					// we would need a way of invalidating the cache
					return (this.serviceNameResolver(svcId) as Promise<string>).then(
						(serviceName: string) => {
							return _.assign({}, { serviceName }, message);
						},
					);
				} else {
					return message;
				}
			})
				.then((msg: LogMessage | null) => {
					if (msg != null) {
						_.each(this.globalListeners, (listener) => {
							listener.push(`${JSON.stringify(msg)}\n`);
						});
					}
				})
				.catch((e) => {
					log.error('Error streaming local log output:', e);
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

	public assignServiceNameResolver(
		resolver: LocalLogBackend['serviceNameResolver'],
	) {
		this.serviceNameResolver = resolver;
	}
}

export default LocalLogBackend;
