import { promises as fs } from 'fs';
import path from 'path';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import type { RedsocksConfig, HostProxyConfig, DnsInput } from './types';
import { ProxyConfig, DnsConfig } from './types';
import { pathOnBoot, readFromBoot, writeToBoot } from '../lib/host-utils';
import { unlinkAll, mkdirp } from '../lib/fs-utils';
import { isENOENT } from '../lib/errors';
import log from '../lib/supervisor-console';
import * as dbus from '../lib/dbus';

const proxyBasePath = pathOnBoot('system-proxy');
const noProxyPath = path.join(proxyBasePath, 'no_proxy');
const redsocksConfPath = path.join(proxyBasePath, 'redsocks.conf');

const disallowedProxyFields = ['local_ip', 'local_port'];

const DEFAULT_REMOTE_IP = '8.8.8.8';
const DEFAULT_REMOTE_PORT = 53;

const isAuthField = (field: string): boolean =>
	['login', 'password'].includes(field);

// ? is a lazy operator, so only the contents up until the first `}(?=\s|$)` is matched.
// (?=\s|$) indicates that `}` must be followed by a whitespace or end of file to match,
// in case there are user fields with brackets such as login or password fields.
const blockRegexFor = (blockLabel: string) =>
	new RegExp(`${blockLabel}\\s?{([\\s\\S]+?)}(?=\\s|$)`);

const baseBlock = {
	log_debug: 'off',
	log_info: 'on',
	log: 'stderr',
	daemon: 'off',
	redirector: 'iptables',
};

export class RedsocksConf {
	public static stringify(config: RedsocksConfig): string {
		const blocks: string[] = [];

		// If no redsocks config is provided or dns is the only config, return empty string.
		// A dns-only config is not valid as it depends on proxy being configured to function.
		if (
			!config.redsocks ||
			!Object.keys(config.redsocks).length ||
			(Object.keys(config.redsocks).length === 1 &&
				Object.hasOwn(config.redsocks, 'dns'))
		) {
			return '';
		}

		// Add base block
		blocks.push(RedsocksConf.stringifyBlock('base', baseBlock));

		const { dns, ...redsocks } = config.redsocks;
		// Add redsocks block
		blocks.push(
			RedsocksConf.stringifyBlock('redsocks', {
				...redsocks,
				local_ip: '127.0.0.1',
				local_port: 12345,
			}),
		);

		// Add optional dnsu2t block if input dns config is true or a string
		if (dns != null) {
			const dnsu2t = dnsToDnsu2t(dns);
			if (dnsu2t) {
				blocks.push(
					RedsocksConf.stringifyBlock('dnsu2t', {
						...dnsu2t,
						local_ip: '127.0.0.1',
						local_port: 53,
					}),
				);
			}
		}

		return blocks.join('\n');
	}

	public static parse(rawConf: string): RedsocksConfig {
		const conf: RedsocksConfig = {};
		rawConf = rawConf.trim();
		if (rawConf.length === 0) {
			return conf;
		}

		// Extract contents of `dnsu2t {...}` using regex if exists
		let dns: DnsConfig | null = null;
		const rawDnsu2tBlockMatch = rawConf.match(blockRegexFor('dnsu2t'));
		if (rawDnsu2tBlockMatch) {
			const rawDnsu2tBlock = RedsocksConf.parseBlock(
				rawDnsu2tBlockMatch[1],
				disallowedProxyFields,
			);
			const maybeDnsConfig = DnsConfig.decode(rawDnsu2tBlock);
			if (isRight(maybeDnsConfig)) {
				dns = maybeDnsConfig.right;
			}
		}

		// Extract contents of `redsocks {...}` using regex
		const rawRedsocksBlockMatch = rawConf.match(blockRegexFor('redsocks'));
		// No group was captured, indicating malformed config
		if (!rawRedsocksBlockMatch) {
			log.warn('Invalid redsocks block in redsocks.conf');
			return conf;
		}
		const rawRedsocksBlock = RedsocksConf.parseBlock(
			rawRedsocksBlockMatch[1],
			disallowedProxyFields,
		);
		const maybeProxyConfig = ProxyConfig.decode(rawRedsocksBlock);
		if (isRight(maybeProxyConfig)) {
			conf.redsocks = {
				...maybeProxyConfig.right,
				// Only add dns subfield if redsocks config is valid
				...(dns && { dns: `${dns.remote_ip}:${dns.remote_port}` }),
			};
			return conf;
		} else {
			log.warn(
				['Invalid redsocks block in redsocks.conf:']
					.concat(Reporter.report(maybeProxyConfig))
					.join('\n'),
			);
			return {};
		}
	}

	private static stringifyBlock(
		label: string,
		block: Record<string, any>,
	): string {
		const lines = Object.entries(block).map(([key, value]) => {
			if (isAuthField(key)) {
				// Add double quotes around login and password fields
				value = `${value.startsWith('"') ? '' : '"'}${value}${value.endsWith('"') ? '' : '"'}`;
			}
			return `\t${key} = ${value};`;
		});
		return `${label} {\n${lines.join('\n')}\n}\n`;
	}

	/**
	 * Given the raw contents of a block redsocks.conf file,
	 * extract to a key-value object.
	 */
	private static parseBlock(
		rawBlockConf: string,
		unsupportedKeys: string[],
	): Record<string, string> {
		const parsedBlock: Record<string, string> = {};

		// Split by newline and optional semicolon
		for (const line of rawBlockConf.split(/;?\n/)) {
			if (!line.trim().length) {
				continue;
			}
			let [key, value] = line.split(/ *?= *?/).map((s) => s.trim());
			// Don't parse unsupported keys
			if (key && unsupportedKeys.some((k) => key.match(k))) {
				continue;
			}
			if (key && value) {
				if (isAuthField(key)) {
					// Remove double quotes from login and password fields for readability
					value = value.replace(/"/g, '');
				}
				parsedBlock[key] = value;
			} else {
				// Skip malformed lines
				log.warn(
					`Ignoring malformed redsocks.conf line ${isAuthField(key) ? `"${key}"` : `"${line.trim()}"`} due to missing key, value, or "="`,
				);
			}
		}

		return parsedBlock;
	}
}

function dnsToDnsu2t(
	dns: DnsInput,
): { remote_ip: string; remote_port: number } | null {
	const dnsu2t = {
		remote_ip: DEFAULT_REMOTE_IP,
		remote_port: DEFAULT_REMOTE_PORT,
	};

	if (typeof dns === 'boolean') {
		return dns ? dnsu2t : null;
	} else {
		// Convert dns string to config object
		const [ip, port] = dns.split(':');
		dnsu2t.remote_ip = ip;
		dnsu2t.remote_port = parseInt(port, 10);
		return dnsu2t;
	}
}

export async function readProxy(): Promise<HostProxyConfig | undefined> {
	// Get and parse redsocks.conf
	let rawConf: string | undefined;
	try {
		rawConf = await readFromBoot(redsocksConfPath, 'utf-8');
	} catch (e: unknown) {
		if (!isENOENT(e)) {
			throw e;
		}
		return undefined;
	}
	const redsocksConf = RedsocksConf.parse(rawConf);

	// Get and parse no_proxy
	const noProxy = await readNoProxy();

	// Build proxy object
	const proxy = {
		...redsocksConf.redsocks,
		...(noProxy.length > 0 && { noProxy }),
	};

	// Assumes mandatory proxy config fields (type, ip, port) are present,
	// even if they very well may not be. It is up to the user to ensure
	// that all the necessary fields are present in the redsocks.conf file.
	return proxy as HostProxyConfig;
}

export async function setProxy(
	conf: RedsocksConfig,
	noProxy: Nullable<string[]>,
) {
	// Ensure proxy directory exists
	await mkdirp(proxyBasePath);

	// Set no_proxy
	let noProxyChanged = false;
	if (noProxy != null) {
		noProxyChanged = await setNoProxy(noProxy);
	}

	// Write to redsocks.conf
	const toWrite = RedsocksConf.stringify(conf);
	if (toWrite) {
		await writeToBoot(redsocksConfPath, toWrite);
	}
	// If target is empty aside from noProxy and noProxy got patched,
	// do not change redsocks.conf to remain backwards compatible
	else if (!noProxyChanged) {
		await unlinkAll(redsocksConfPath);
	}

	// Restart services using dbus
	await restartProxyServices();
}

async function restartProxyServices() {
	// restart balena-proxy-config if it is loaded and NOT PartOf redsocks-conf.target
	if (
		(
			await Promise.any([
				dbus.servicePartOf('balena-proxy-config'),
				dbus.servicePartOf('resin-proxy-config'),
			])
		).includes('redsocks-conf.target') === false
	) {
		await Promise.any([
			dbus.restartService('balena-proxy-config'),
			dbus.restartService('resin-proxy-config'),
		]);
	}

	// restart redsocks if it is loaded and NOT PartOf redsocks-conf.target
	if (
		(await dbus.servicePartOf('redsocks')).includes('redsocks-conf.target') ===
		false
	) {
		await dbus.restartService('redsocks');
	}
}

async function readNoProxy(): Promise<string[]> {
	try {
		const noProxy = await readFromBoot(noProxyPath, 'utf-8')
			// Prevent empty newline from being reported as a noProxy address
			.then((addrs) => addrs.split('\n').filter((addr) => addr !== ''));

		if (noProxy.length) {
			return noProxy;
		} else {
			return [];
		}
	} catch (e: unknown) {
		if (!isENOENT(e)) {
			throw e;
		}
		return [];
	}
}

async function setNoProxy(list: Nullable<string[]>) {
	const current = await readNoProxy();
	if (!list || !Array.isArray(list) || !list.length) {
		await unlinkAll(noProxyPath);
	} else {
		await fs.writeFile(noProxyPath, list.join('\n'));
	}
	// If noProxy has changed, return true
	return (
		Array.isArray(list) &&
		(current.length !== list.length ||
			!current.every((addr) => list.includes(addr)))
	);
}
