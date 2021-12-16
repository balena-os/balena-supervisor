import { NOTFOUND } from 'dns';
import * as mdnsResolver from 'mdns-resolver';
import '@balena/happy-eyeballs/eye-patch';

class DnsLookupError extends Error {
	public constructor(public code: string = NOTFOUND) {
		super();
	}
}

interface DnsLookupCallback {
	(err: any): void;
	(err: undefined | null, address: string, family: number): void;
	(
		err: undefined | null,
		addresses: Array<{ address: string; family: number }>,
	): void;
}

interface DnsLookupOpts {
	verbatim: boolean;
	all: boolean;
	family: number;
}

// This was originally wrapped in a do block in
// coffeescript, and it's not clear now why that was the
// case, so I'm going to maintain that behaviour
(() => {
	// Make NodeJS RFC 3484 compliant for properly handling IPv6
	// See: https://github.com/nodejs/node/pull/14731
	//      https://github.com/nodejs/node/pull/17793
	const dns = require('dns');
	const { lookup } = dns;

	dns.lookup = (
		name: string,
		opts: Partial<DnsLookupOpts> | number | null | undefined,
		cb: DnsLookupCallback,
	) => {
		if (typeof cb !== 'function') {
			return lookup(name, { verbatim: true }, opts);
		}

		/* =====================================================
		 * NOTE: This is required since Alpine/musl-based images
		 * do not support mDNS name resolution in the musl libs.
		 *
		 * In order to support .local mDNS names in development
		 * and on openBalena setups, this extra code will perform
		 * the lookup instead of passing it to the built-in
		 * function.
		   ================================================== */
		if (name && name.endsWith('.local')) {
			// determine which resolvers to use...
			const getResolvers = () => {
				// logic to determine the families based on Node docs.
				// See: https://nodejs.org/api/dns.html#dns_dns_lookup_hostname_options_callback
				const families = (() => {
					// strictly defined...
					if (opts === 4 || opts === 6) {
						return [opts as number];
					}

					// opts is passed, not a number and the `family` parameter is passed...
					if (opts && typeof opts !== 'number' && opts.family) {
						return [opts.family];
					}

					// default to resolve both v4 and v6...
					return [4, 6];
				})();

				// map them and return...
				return families.map((family) => {
					return mdnsResolver
						.resolve(name, family === 6 ? 'AAAA' : 'A')
						.catch(() => {
							return '';
						})
						.then((address) => {
							return {
								address,
								family,
							};
						});
				});
			};

			// resolve the addresses...
			return Promise.all(getResolvers()).then((results) => {
				// remove any that didn't resolve...
				let allAddresses = results.filter((result) => result.address !== '');

				// unless the results should be returned verbatim, sort them so v4 comes first...
				if (opts && typeof opts !== 'number' && !opts.verbatim) {
					allAddresses = allAddresses.sort((a, b) => a.family - b.family);
				}

				// see if we resolved anything...
				if (allAddresses.length === 0) {
					// nothing! return a suitable error...
					return cb(new DnsLookupError());
				}

				// all the addresses were requested...
				if (opts && typeof opts !== 'number' && opts.all) {
					return cb(null, allAddresses);
				}

				// only a single address was requested...
				const [{ address, family }] = allAddresses;
				return cb(null, address, family);
			});
		}

		return lookup(name, Object.assign({ verbatim: true }, opts), cb);
	};
})();

import Supervisor from './supervisor';

const supervisor = new Supervisor();
supervisor.init();
