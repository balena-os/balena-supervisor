import { promises as fs } from 'fs';
import path from 'path';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import { ProxyConfig } from './types';
import type { RedsocksConfig } from './types';
import { pathOnBoot, readFromBoot } from '../lib/host-utils';
import { unlinkAll } from '../lib/fs-utils';
import { isENOENT } from '../lib/errors';
import log from '../lib/supervisor-console';

const proxyBasePath = pathOnBoot('system-proxy');
const noProxyPath = path.join(proxyBasePath, 'no_proxy');

const disallowedProxyFields = ['local_ip', 'local_port'];

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

		if (config.redsocks && Object.keys(config.redsocks).length > 0) {
			blocks.push(RedsocksConf.stringifyBlock('base', baseBlock));
			blocks.push(
				RedsocksConf.stringifyBlock('redsocks', {
					...config.redsocks,
					local_ip: '127.0.0.1',
					local_port: 12345,
				}),
			);
		}

		return blocks.length ? blocks.join('\n') : '';
	}

	public static parse(rawConf: string): RedsocksConfig {
		const conf: RedsocksConfig = {};
		rawConf = rawConf.trim();
		if (rawConf.length === 0) {
			return conf;
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

export async function readNoProxy(): Promise<string[]> {
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

export async function setNoProxy(list: string[]) {
	if (!list || !Array.isArray(list) || !list.length) {
		await unlinkAll(noProxyPath);
	} else {
		await fs.writeFile(noProxyPath, list.join('\n'));
	}
}
