import type { LookupAddress } from 'dns';
import { NOTFOUND } from 'dns';
import * as mdnsResolver from 'mdns-resolver';

class DnsLookupError extends Error {
	public constructor(public code: string = NOTFOUND) {
		super();
	}
}

interface DnsLookupCallback {
	(err: NodeJS.ErrnoException): void;
	(
		err: NodeJS.ErrnoException | null,
		address: string | LookupAddress,
		family: number,
	): void;
	(err: NodeJS.ErrnoException | null, addresses: LookupAddress[]): void;
}

interface DnsLookupOpts {
	verbatim: boolean;
	all: boolean;
	family: number;
}

/*
 * =====================================================
 * NOTE: This is required since Alpine/musl-based images
 * do not support mDNS name resolution in the musl libs.
 *
 * In order to support .local mDNS names in development
 * and on openBalena setups, this extra code will perform
 * the lookup instead of passing it to the built-in
 * function.
 * ==================================================
 */
async function mdnsLookup(
	name: string,
	opts: Partial<DnsLookupOpts> | number | null | undefined,
	cb: DnsLookupCallback,
) {
	// determine which resolvers to use...
	const getResolvers = () => {
		// logic to determine the families based on Node docs.
		// See: https://nodejs.org/api/dns.html#dns_dns_lookup_hostname_options_callback
		const families = (() => {
			// strictly defined...
			if (opts === 4 || opts === 6) {
				return [opts];
			}

			// opts is passed, not a number and the `family` parameter is passed...
			if (opts && typeof opts !== 'number' && opts.family) {
				return [opts.family];
			}

			// default to resolve both v4 and v6...
			return [4, 6];
		})();

		// map them and return...
		return families.map(async (family) => {
			let address = '';
			try {
				address = await mdnsResolver.resolve(name, family === 6 ? 'AAAA' : 'A');
			} catch {
				/* noop */
			}

			return { address, family };
		});
	};

	// resolve the addresses...
	const results = await Promise.all(getResolvers());
	// remove any that didn't resolve...
	let allAddresses = results.filter((result) => result.address !== '');

	// unless the results should be returned verbatim, sort them so v4 comes first...
	if (opts && typeof opts !== 'number' && !opts.verbatim) {
		allAddresses = allAddresses.sort((a, b) => a.family - b.family);
	}

	// see if we resolved anything...
	if (allAddresses.length === 0) {
		// nothing! return a suitable error...
		cb(new DnsLookupError());
		return;
	}

	// all the addresses were requested...
	if (opts && typeof opts !== 'number' && opts.all) {
		cb(null, allAddresses);
		return;
	}

	// only a single address was requested...
	const [{ address: addr, family: fmly }] = allAddresses;
	cb(null, addr, fmly);
}

// This was originally wrapped in a do block in
// coffeescript, and it's not clear now why that was the
// case, so I'm going to maintain that behaviour
(() => {
	// We disable linting for the next line. The require call
	// is necesary for monkey-patching the dns module
	const dns = require('dns') as typeof import('dns'); // eslint-disable-line
	const { lookup } = dns;

	dns.lookup = ((name, opts, cb?) => {
		if (typeof opts === 'function') {
			lookup(name, opts);
			return;
		}

		const $cb = cb as DnsLookupCallback;
		// We need to cast opts to `any` because things get weird with the overloaded function signatures, particularly with 2 vs 3 parameters. This isn't ideal but
		// it is better than the previous version where everything was implicitly `any`
		const $opts = opts as any;

		// Try a regular dns lookup first
		lookup(name, $opts, ((...args: Parameters<DnsLookupCallback>) => {
			if (args[0] == null) {
				$cb(...args);
				return;
			}

			// If the regular lookup fails, we perform a mdns lookup if the
			// name ends with .local
			if (name?.endsWith('.local')) {
				void mdnsLookup(name, $opts, $cb);
				return;
			}

			$cb(...args);
		}) as DnsLookupCallback);
	}) as typeof lookup;
})();
