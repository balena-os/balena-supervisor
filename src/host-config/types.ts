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
