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

export const DnsConfig = t.type({
	remote_ip: t.string,
	remote_port: NumericIdentifier,
});
export type DnsConfig = t.TypeOf<typeof DnsConfig>;

/**
 * The internal object representation of redsocks.conf, obtained
 * from RedsocksConf.parse
 */
export const RedsocksConfig = t.partial({
	redsocks: ProxyConfig,
	dns: DnsConfig,
});
export type RedsocksConfig = t.TypeOf<typeof RedsocksConfig>;

const HostProxyConfigWithoutDns = t.intersection([
	ProxyConfig,
	t.partial({
		noProxy: t.array(t.string),
	}),
]);
type HostProxyConfigWithoutDns = t.TypeOf<typeof HostProxyConfigWithoutDns>;

/**
 * An intersection of writeable redsocks.conf configurations for the
 * redsocks {...} and dns {...} blocks, and additional noProxy field
 * (which is a config relating to proxy configuration)
 */
export const HostProxyConfig = t.partial({
	proxy: HostProxyConfigWithoutDns,
	dns: DnsConfig,
});
export type HostProxyConfig = t.TypeOf<typeof HostProxyConfig>;

/**
 * A host configuration object which includes redsocks proxy configuration
 * and hostname configuration. This is the input type provided by the user
 * with host-config PATCH and provided to the user with host-config GET.
 */
export const HostConfiguration = t.type({
	network: t.exact(
		t.partial({
			proxy: t.exact(HostProxyConfigWithoutDns),
			hostname: t.string,
			dns: t.union([t.string, t.boolean]),
		}),
	),
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
		// dns was added after the initial implementation, so its type is more
		// strictly enforced than the other older fields.
		dns: t.union([t.string, t.boolean]),
	}),
});
export type LegacyHostConfiguration = t.TypeOf<typeof LegacyHostConfiguration>;
