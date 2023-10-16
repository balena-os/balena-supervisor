import * as _ from 'lodash';

import { Readable } from 'stream';
import { checkInt } from '../lib/validation';
import { LogBackend, LogMessage } from './log-backend';

import log from '../lib/supervisor-console';

export class LocalLogBackend extends LogBackend {
	private globalListeners: Readable[] = [];

	private serviceNameResolver: (serviceId: number) => Promise<string>;

	public async log(message: LogMessage): Promise<void> {
		if (this.publishEnabled) {
			try {
				if (!message.isSystem) {
					if (this.serviceNameResolver == null) {
						// This means there is no listener assigned, drop the logs
						// TODO: Store these, and resolve them when a listener is attached
						return;
					}
					const svcId = checkInt(message.serviceId);
					if (svcId == null) {
						log.warn(
							'Non-integer service id found in local logs:\n',
							JSON.stringify(message),
						);
						return;
					}
					// TODO: Can we cache this value? The service ids are reused, so
					// we would need a way of invalidating the cache
					const serviceName = await this.serviceNameResolver(svcId);

					message = Object.assign({}, { serviceName }, message);
				}
				_.each(this.globalListeners, (listener) => {
					listener.push(`${JSON.stringify(message)}\n`);
				});
			} catch (e) {
				log.error('Error streaming local log output:', e);
			}
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
