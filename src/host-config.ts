import { stripIndent } from 'common-tags';
import _ from 'lodash';
import { promises as fs } from 'fs';
import path from 'path';

import * as config from './config';
import * as applicationManager from './compose/application-manager';
import * as dbus from './lib/dbus';
import { isENOENT } from './lib/errors';
import { mkdirp, unlinkAll } from './lib/fs-utils';
import {
	writeToBoot,
	readFromBoot,
	pathOnRoot,
	pathOnBoot,
} from './lib/host-utils';
import * as updateLock from './lib/update-lock';
import log from './lib/supervisor-console';

const proxyFields = ['type', 'ip', 'port', 'login', 'password'];
const dnsFields = ['remote_ip', 'remote_port'];

const proxyBasePath = pathOnBoot('system-proxy');
const redsocksConfPath = path.join(proxyBasePath, 'redsocks.conf');
const noProxyPath = path.join(proxyBasePath, 'no_proxy');

interface ProxyConfig {
	[key: string]: string | string[] | number;
}

interface DnsConfig {
	[key: string]: string;
}

interface HostConfig {
	network: {
		proxy?: ProxyConfig;
		hostname?: string;
		dns?: DnsConfig | string | boolean;
	};
}

const isAuthField = (field: string): boolean =>
	['login', 'password'].includes(field);

const memoizedAuthRegex = _.memoize(
	(proxyField: string) => new RegExp(proxyField + '\\s*=\\s*"(.*)"\\s*;'),
);

const memoizedRegex = _.memoize(
	// Add beginning-of-line RegExp to prevent local_ip and local_port static fields from being memoized
	(proxyField) => new RegExp('^\\s*' + proxyField + '\\s*=\\s*([^;\\s]*)\\s*;'),
);

async function readProxy(): Promise<
	[Nullable<ProxyConfig>, Nullable<DnsConfig>]
> {
	let rawRedsocksConf: string;
	try {
		rawRedsocksConf = await readFromBoot(redsocksConfPath, 'utf-8');
	} catch (e: unknown) {
		if (!isENOENT(e)) {
			throw e;
		}
		return [null, null];
	}

	const redsocksConfBlocks: [Nullable<ProxyConfig>, Nullable<DnsConfig>] = [
		null,
		null,
	];

	// Each configuration block should be separated by two newlines
	const confBlocks = rawRedsocksConf.split('\n\n');

	// Handle redsocks block
	const proxyConf: ProxyConfig = {};
	const redsocksBlock = confBlocks.find((block) =>
		block.includes('redsocks {'),
	);
	if (redsocksBlock != null) {
		const proxyLines = redsocksBlock.split('\n');
		for (const line of proxyLines) {
			for (const proxyField of proxyFields) {
				let match: string[] | null = null;
				if (isAuthField(proxyField)) {
					match = line.match(memoizedAuthRegex(proxyField));
				} else {
					match = line.match(memoizedRegex(proxyField));
				}

				if (match != null) {
					proxyConf[proxyField] = match[1];
				}
			}
		}
		redsocksConfBlocks[0] = proxyConf;
	}

	// Handle dns block
	const dnsConf: DnsConfig = {};
	const dnsBlock = confBlocks.find((block) => block.includes('dnsu2t {'));
	if (dnsBlock != null) {
		const dnsLines = dnsBlock.split('\n');
		for (const line of dnsLines) {
			for (const dnsField of dnsFields) {
				const match = line.match(memoizedRegex(dnsField));
				if (match != null) {
					// Transform snakecase dnsField to camelCase
					const dnsFieldCamelcase = dnsField.replace(
						/* eslint-disable @typescript-eslint/no-shadow */
						// This is necessary because ESLint mistakes _ here
						// for the lodash import
						/(?!^)_(.)/g,
						(_, c) => c.toUpperCase(),
					);
					dnsConf[dnsFieldCamelcase] = match[1];
				}
			}
		}
		redsocksConfBlocks[1] = dnsConf;
	}

	// Handle noProxy
	try {
		const noProxy = await readFromBoot(noProxyPath, 'utf-8')
			// Prevent empty newline from being reported as a noProxy address
			.then((addrs) => addrs.split('\n').filter((addr) => addr !== ''));

		if (noProxy.length) {
			proxyConf.noProxy = noProxy;
		}
	} catch (e: unknown) {
		if (!isENOENT(e)) {
			throw e;
		}
	}

	// Convert port to number per API doc spec
	if (proxyConf.port) {
		proxyConf.port = parseInt(proxyConf.port as string, 10);
	}

	return redsocksConfBlocks;
}

const base = stripIndent`
	base {
		log_debug = off;
		log_info = on;
		log = stderr;
		daemon = off;
		redirector = iptables;
	}
`;

function generateRedsocksConfEntries(conf: ProxyConfig): string {
	const entries: string[] = [];
	for (const field of proxyFields) {
		let v = conf[field];
		if (v != null) {
			if (isAuthField(field)) {
				// Escape any quotes in the field value
				v = `"${v.toString().replace(/"/g, '\\"')}"`;
			}
			entries.push(`\t${field} = ${v};`);
		}
	}
	return entries.join('\n');
}

function buildProxyConf(
	targetConf?: ProxyConfig,
	currentConf?: ProxyConfig,
): string {
	const build = (conf: ProxyConfig) =>
		stripIndent`
		redsocks {
			local_ip = 127.0.0.1;
			local_port = 12345;` +
		`\n${generateRedsocksConfEntries(conf)}` +
		`\n}`;

	const currentWithoutNoProxy = { ...currentConf };
	const targetWithoutNoProxy = { ...targetConf };
	delete currentWithoutNoProxy.noProxy;
	delete targetWithoutNoProxy.noProxy;

	// If target is null or undefined, keep current proxy config if it exists.
	// This can happen if a patch request is made to only modify hostname or dns.
	if (targetConf == null) {
		if (
			currentWithoutNoProxy != null &&
			Object.keys(currentWithoutNoProxy).length > 0
		) {
			return build(currentWithoutNoProxy);
		}
		return '';
	}

	// If target only has noProxy, keep current config
	if (
		Object.keys(targetWithoutNoProxy).length === 0 &&
		targetConf?.noProxy != null &&
		Object.keys(currentWithoutNoProxy).length > 0
	) {
		return build(currentWithoutNoProxy);
	}

	// If target is empty, remove proxy config
	if (Object.keys(targetConf).length === 0) {
		return '';
	}

	// Build redsocks block using targetConf to override currentConf
	return build({ ...currentWithoutNoProxy, ...targetWithoutNoProxy });
}

function buildDnsConf(
	targetConf?: DnsConfig | string | boolean,
	currentConf?: DnsConfig,
): string {
	const DEFAULT_IP = '8.8.8.8';
	const DEFAULT_PORT = '53';
	const build = (remoteIp: string, remotePort: string) => stripIndent`
		dnsu2t {
			local_ip = 127.0.0.1;
			local_port = 53;
			remote_ip = ${remoteIp};
			remote_port = ${remotePort};
		}`;

	const validCurrentConf =
		currentConf != null &&
		Object.hasOwn(currentConf, 'remoteIp') &&
		Object.hasOwn(currentConf, 'remotePort');
	// If target is null or undefined, keep current dns config if it exists and is valid.
	// This can happen if a patch is made that only modifies the proxy and/or hostname.
	if (targetConf == null && validCurrentConf) {
		return build(currentConf.remoteIp, currentConf.remotePort);
	}

	// If false, remove dns block
	if (targetConf === false) {
		return '';
	}

	// If true, use default remote IP and port
	if (targetConf === true) {
		return build(DEFAULT_IP, DEFAULT_PORT);
	}

	// If string, parse and use provided remote IP and port.
	// Use current conf for any fields not provided, then
	// use defaults if any current conf is not provided.
	if (typeof targetConf === 'string') {
		const [rIp, rPort] = targetConf.split(':');
		const remoteIp = rIp || DEFAULT_IP;
		const remotePort = rPort || DEFAULT_PORT;
		if (!rIp) {
			log.info(`No remote_ip provided for dns, defaulting to ${remoteIp}`);
		}
		if (!rPort) {
			log.info(`No remote_port provided for dns, defaulting to ${remotePort}`);
		}
		return build(remoteIp, remotePort);
	}

	// targetConf is null or undefined and currentConf is not
	// valid or does not exist, so don't add dns block
	return '';
}

async function setRedsocksConf(
	proxyConf?: ProxyConfig,
	dnsConf?: string | boolean,
): Promise<void> {
	// Get current proxy & dns confs for patching
	let currentProxyConf: ProxyConfig | undefined;
	let currentDnsConf: DnsConfig | undefined;
	try {
		const [r, d] = await readProxy();
		if (r) {
			currentProxyConf = r;
		}
		if (d) {
			currentDnsConf = d;
		}
	} catch {
		// Noop - current redsocks.conf does not exist
	}

	const proxyToAdd = buildProxyConf(proxyConf, currentProxyConf);
	const dnsToAdd = buildDnsConf(dnsConf, currentDnsConf);

	let redsocksConf: string;

	if (proxyToAdd || dnsToAdd) {
		await mkdirp(proxyBasePath);
		redsocksConf = base;
		if (proxyToAdd) {
			redsocksConf += '\n\n' + proxyToAdd;
		}
		if (dnsToAdd) {
			redsocksConf += '\n\n' + dnsToAdd;
		}
		// Update no_proxy if exists
		if (proxyConf?.noProxy && Array.isArray(proxyConf.noProxy)) {
			await writeToBoot(noProxyPath, proxyConf.noProxy.join('\n'));
		}
		await writeToBoot(redsocksConfPath, redsocksConf);
	} else if (!proxyToAdd && !dnsToAdd) {
		// Neither proxy or dns are configured, remove config files
		await unlinkAll(redsocksConfPath, noProxyPath);
	} else if (!proxyToAdd) {
		// Only proxy isn't configured, remove no_proxy file
		await unlinkAll(noProxyPath);
	}

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

const hostnamePath = pathOnRoot('/etc/hostname');
async function readHostname() {
	const hostnameData = await fs.readFile(hostnamePath, 'utf-8');
	return _.trim(hostnameData);
}

async function setHostname(val: string) {
	// Changing the hostname on config.json will trigger
	// the OS config-json service to restart the necessary services
	// so the change gets reflected on containers
	await config.set({ hostname: val });
}

export async function get(): Promise<HostConfig> {
	const [proxy, dns] = await readProxy();
	const network: HostConfig['network'] = {
		hostname: await readHostname(),
	};
	if (proxy != null && Object.keys(proxy).length > 0) {
		network.proxy = proxy;
	}
	if (dns != null && Object.keys(dns).length > 0) {
		network.dns = dns;
	}
	return { network };
}

export async function patch(
	conf: HostConfig,
	force: boolean = false,
): Promise<void> {
	const apps = await applicationManager.getCurrentApps();
	const appIds = Object.keys(apps).map((strId) => parseInt(strId, 10));

	// It's possible for appIds to be an empty array, but patch shouldn't fail
	// as it's not dependent on there being any running user applications.
	return updateLock.lock(appIds, { force }, async () => {
		const promises: Array<Promise<void>> = [];
		if (conf != null && conf.network != null) {
			if (conf.network.proxy != null || conf.network.dns != null) {
				// When providing dns as an input, only string or boolean are accepted,
				// whereas the output when getting config will always be an object with type DnsConfig
				promises.push(
					setRedsocksConf(
						conf.network.proxy,
						conf.network.dns as string | boolean,
					),
				);
			}
			if (conf.network.hostname != null) {
				promises.push(setHostname(conf.network.hostname));
			}
		}
		await Promise.all(promises);
	});
}
