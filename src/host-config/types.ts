import * as t from 'io-ts';
import { NumericIdentifier } from '../types';

export const ProxyConfig = t.intersection([
	t.type({
		type: t.union([
			t.literal('socks4'),
			t.literal('socks5'),
			t.literal('http-connect'),
			t.literal('http-relay'),
		]),
		ip: t.string,
		port: NumericIdentifier,
	}),
	// login & password are optional fields
	t.partial({
		login: t.string,
		password: t.string,
	}),
]);
export type ProxyConfig = t.TypeOf<typeof ProxyConfig>;

/**
 * The internal object representation of redsocks.conf, obtained
 * from RedsocksConf.parse
 */
export const RedsocksConfig = t.partial({
	redsocks: ProxyConfig,
});
export type RedsocksConfig = t.TypeOf<typeof RedsocksConfig>;

/**
 * An intersection of writeable redsocks.conf configurations, and
 * additional noProxy field (which is a config relating to proxy configuration)
 */
export const HostProxyConfig = t.intersection([
	ProxyConfig,
	t.partial({
		noProxy: t.array(t.string),
	}),
]);
export type HostProxyConfig = t.TypeOf<typeof HostProxyConfig>;

/**
 * A host configuration object which includes redsocks proxy configuration
 * and hostname configuration. This is the input type provided by the user
 * with host-config PATCH and provided to the user with host-config GET.
 */
export const HostConfiguration = t.type({
	network: t.partial({
		proxy: HostProxyConfig,
		hostname: t.string,
	}),
});
export type HostConfiguration = t.TypeOf<typeof HostConfiguration>;

/**
 * A user may provide an input which is not a valid HostConfiguration object,
 * but we've historically accepted these malformed configurations. This type
 * covers the case of a user providing a configuration which is not strictly
 * valid but has the correct shape.
 */
export const LegacyHostConfiguration = t.type({
	network: t.partial({
		proxy: t.record(t.string, t.any),
		hostname: t.string,
	}),
});
export type LegacyHostConfiguration = t.TypeOf<typeof LegacyHostConfiguration>;
