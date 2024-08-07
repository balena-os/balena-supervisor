import { promises as fs } from 'fs';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import type { RedsocksConfig, ProxyConfig, DnsConfig } from './types';
import { HostConfiguration, LegacyHostConfiguration } from './types';
import {
	readProxy,
	setProxy,
	DEFAULT_REMOTE_IP,
	DEFAULT_REMOTE_PORT,
} from './proxy';
import * as config from '../config';
// FIXME: The host-config module shouldn't be importing from compose
import * as applicationManager from '../compose/application-manager';
import { pathOnRoot } from '../lib/host-utils';
import log from '../lib/supervisor-console';
import * as updateLock from '../lib/update-lock';

const hostnamePath = pathOnRoot('/etc/hostname');

async function readHostname() {
	const hostnameData = await fs.readFile(hostnamePath, 'utf-8');
	return hostnameData.trim();
}

async function setHostname(val: string) {
	let hostname = val;
	// If hostname is an empty string, return first 7 digits of device uuid
	if (!val) {
		const uuid = await config.get('uuid');
		hostname = uuid?.slice(0, 7) as string;
	}
	// Changing the hostname on config.json will trigger
	// the OS config-json service to restart the necessary services
	// so the change gets reflected on containers
	await config.set({ hostname });
}

export function parse(
	conf: unknown,
): HostConfiguration | LegacyHostConfiguration {
	const decoded = HostConfiguration.decode(conf);

	if (isRight(decoded)) {
		return decoded.right;
	} else {
		log.warn(
			['Malformed host config detected, things may not behave as expected:']
				.concat(Reporter.report(decoded))
				.join('\n'),
		);
		// We haven't strictly validated user input since introducing the API,
		// endpoint, so accept configs where values may not be of the right type
		// but have the right shape for backwards compatibility.
		const legacyDecoded = LegacyHostConfiguration.decode(conf);
		if (isRight(legacyDecoded)) {
			return legacyDecoded.right;
		}
	}
	throw new Error('Could not parse host config input to a valid format');
}

function patchProxy(
	currentConf: Partial<RedsocksConfig>,
	targetConf: {
		redsocks?: Partial<ProxyConfig> | null;
		dns?: DnsConfig | null;
	},
): RedsocksConfig {
	const patchedConf: RedsocksConfig = {};

	// If input is empty, redsocks config should be removed
	if (!targetConf || Object.keys(targetConf).length === 0) {
		return patchedConf;
	}

	// Assumes that currentConf dns is type DnsConfig if it exists.
	// Target conf should be DnsConfig if it exists.
	const dns = {
		...currentConf.dns,
		...targetConf.dns,
	};
	patchedConf.dns = dns as DnsConfig;

	// Delete dns config if null
	if (targetConf.dns === null) {
		delete patchedConf.dns;
	}

	// This method assumes that currentConf is a full ProxyConfig
	// for backwards compatibility, so patchedConf.redsocks should
	// also be a full ProxyConfig.
	const redsocks = {
		...currentConf.redsocks,
		...targetConf.redsocks,
	};
	patchedConf.redsocks = redsocks as ProxyConfig;

	// Delete redsocks and dns configs if redsocks is not configured,
	// because dns config depends on redsocks to work
	if (
		targetConf.redsocks === null ||
		(typeof targetConf.redsocks === 'object' &&
			Object.keys(targetConf.redsocks).length === 0)
	) {
		delete patchedConf.redsocks;
		delete patchedConf.dns;
	}

	return patchedConf;
}

export async function patch(
	targetConf: HostConfiguration | LegacyHostConfiguration,
	force: boolean = false,
): Promise<void> {
	const apps = await applicationManager.getCurrentApps();
	const appIds = Object.keys(apps).map((strId) => parseInt(strId, 10));

	const { network: target } = targetConf;

	if (target.hostname != null) {
		await setHostname(target.hostname);
	}

	if (target.proxy != null || target.dns != null) {
		// It's possible for appIds to be an empty array, but patch shouldn't fail
		// as it's not dependent on there being any running user applications.
		return updateLock.lock(appIds, { force }, async () => {
			// Get current proxy config
			const current = await readProxy();
			const currentConf: Partial<RedsocksConfig> = {};
			if (current) {
				const { proxy, dns } = current;
				if (proxy) {
					delete proxy.noProxy;
					currentConf.redsocks = proxy;
				}
				if (dns) {
					currentConf.dns = dns;
				}
			}

			const toPatch: {
				redsocks?: Partial<ProxyConfig> | null;
				dns?: DnsConfig | null;
			} = {};

			// Extract target proxy from input
			if (target.proxy) {
				// target.proxy could be Record<string, any> due to legacy support,
				// so only extract only defined fields that are part of ProxyConfig
				const { type, ip, port, login, password } = target.proxy;
				const definedConf = Object.fromEntries(
					Object.entries({ type, ip, port, login, password }).filter(
						([, value]) => value,
					),
				) as ProxyConfig;
				if (Object.keys(definedConf).length > 0) {
					toPatch.redsocks = definedConf;
				} else {
					// Mark for deletion if target proxy is empty
					toPatch.redsocks = null;
				}
			}

			// Extract target dns from input
			if (typeof target.dns === 'boolean') {
				if (target.dns) {
					// If dns is true, set to default dns config
					toPatch.dns = {
						remote_ip: DEFAULT_REMOTE_IP,
						remote_port: DEFAULT_REMOTE_PORT,
					};
				} else {
					// Mark for deletion if target dns is false
					toPatch.dns = null;
				}
			}
			if (typeof target.dns === 'string') {
				// Convert dns string into DnsConfig object
				const [ip, port] = target.dns.split(':');
				toPatch.dns = {
					remote_ip: ip || DEFAULT_REMOTE_IP,
					remote_port: port ? parseInt(port, 10) : DEFAULT_REMOTE_PORT,
				};
			}

			// Merge current & target redsocks.conf
			const patchedConf = patchProxy(currentConf, toPatch);
			await setProxy(patchedConf, target.proxy?.noProxy);
		});
	}
}

export async function get(): Promise<HostConfiguration> {
	const conf = await readProxy();
	return {
		network: {
			hostname: await readHostname(),
			// Only return proxy if not undefined
			...(conf?.proxy && { proxy: conf.proxy }),
			// Only return dns if not undefined, and return as a string
			...(conf?.dns && {
				dns: `${conf.dns.remote_ip}:${conf.dns.remote_port}`,
			}),
		},
	};
}
