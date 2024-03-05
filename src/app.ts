import { set } from '@balena/es-version';
// Set the desired es version for downstream modules that support it, before we import any
set('es2019');

import { NOTFOUND } from 'dns';
import mdnsResolver from 'mdns-resolver';

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
		return cb(new DnsLookupError());
	}

	// all the addresses were requested...
	if (opts && typeof opts !== 'number' && opts.all) {
		return cb(null, allAddresses);
	}

	// only a single address was requested...
	const [{ address: addr, family: fmly }] = allAddresses;
	return cb(null, addr, fmly);
}

// This was originally wrapped in a do block in
// coffeescript, and it's not clear now why that was the
// case, so I'm going to maintain that behaviour
(() => {
	// Make NodeJS RFC 3484 compliant for properly handling IPv6
	// See: https://github.com/nodejs/node/pull/14731
	//      https://github.com/nodejs/node/pull/17793
	// We disable linting for the next line. The require call
	// is necesary for monkey-patching the dns module
	const dns = require('dns'); // eslint-disable-line
	const { lookup } = dns;

	dns.lookup = (
		name: string,
		opts: Partial<DnsLookupOpts> | number | null | undefined,
		cb: DnsLookupCallback,
	) => {
		if (typeof cb !== 'function') {
			return lookup(name, { verbatim: true }, opts);
		}

		// Try a regular dns lookup first
		return lookup(
			name,
			Object.assign({ verbatim: true }, opts),
			(error: any, address: string, family: number) => {
				if (error == null) {
					return cb(null, address, family);
				}

				// If the regular lookup fails, we perform a mdns lookup if the
				// name ends with .local
				if (name && name.endsWith('.local')) {
					return mdnsLookup(name, opts, cb);
				}

				return cb(error);
			},
		);
	};
})();

import '@balena/happy-eyeballs/eye-patch';
import Supervisor from './supervisor';
import process from 'process';
import log from './lib/supervisor-console';

// Register signal handlers before starting the supervisor service
process.on('SIGTERM', () => {
	log.info('Received SIGTERM. Exiting.');

	// This is standard exit code to indicate a graceful shutdown
	// it equals 128 + 15 (the signal code)
	process.exit(143);
});

const supervisor = new Supervisor();
supervisor.init().catch((e) => {
	log.error('Uncaught exception:', e);

	// Terminate the process to avoid leaving the supervisor in a bad state
	process.exit(1);
});
