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

const proxyFields = ['type', 'ip', 'port', 'login', 'password'];

const proxyBasePath = pathOnBoot('system-proxy');
const redsocksConfPath = path.join(proxyBasePath, 'redsocks.conf');
const noProxyPath = path.join(proxyBasePath, 'no_proxy');

interface ProxyConfig {
	[key: string]: string | string[] | number;
}

interface HostConfig {
	network: {
		proxy?: ProxyConfig;
		hostname?: string;
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

async function readProxy(): Promise<ProxyConfig | undefined> {
	const conf: ProxyConfig = {};
	let redsocksConf: string;
	try {
		redsocksConf = await readFromBoot(redsocksConfPath, 'utf-8');
	} catch (e: unknown) {
		if (!isENOENT(e)) {
			throw e;
		}
		return;
	}
	const lines = redsocksConf.split('\n');

	for (const line of lines) {
		for (const proxyField of proxyFields) {
			let match: string[] | null = null;
			if (isAuthField(proxyField)) {
				match = line.match(memoizedAuthRegex(proxyField));
			} else {
				match = line.match(memoizedRegex(proxyField));
			}

			if (match != null) {
				conf[proxyField] = match[1];
			}
		}
	}

	try {
		const noProxy = await readFromBoot(noProxyPath, 'utf-8')
			// Prevent empty newline from being reported as a noProxy address
			.then((addrs) => addrs.split('\n').filter((addr) => addr !== ''));

		if (noProxy.length) {
			conf.noProxy = noProxy;
		}
	} catch (e: unknown) {
		if (!isENOENT(e)) {
			throw e;
		}
	}

	// Convert port to number per API doc spec
	if (conf.port) {
		conf.port = parseInt(conf.port as string, 10);
	}
	return conf;
}

function generateRedsocksConfEntries(conf: ProxyConfig): string {
	const entries = [];
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

const base = () => stripIndent`
	base {
		log_debug = off;
		log_info = on;
		log = stderr;
		daemon = off;
		redirector = iptables;
	}
`;

const redsocks = (conf: ProxyConfig) =>
	stripIndent`
	redsocks {
		local_ip = 127.0.0.1;
		local_port = 12345;` +
	`\n${generateRedsocksConfEntries(conf)}` +
	`\n}`;

async function setProxy(conf: ProxyConfig): Promise<void> {
	const proxyEmpty = Object.keys(conf).length === 0;
	if (proxyEmpty) {
		await unlinkAll(redsocksConfPath, noProxyPath);
	} else {
		await mkdirp(proxyBasePath);
		if (Array.isArray(conf.noProxy)) {
			await writeToBoot(noProxyPath, conf.noProxy.join('\n'));
		}

		let currentConf: ProxyConfig | undefined;
		try {
			currentConf = await readProxy();
		} catch {
			// Noop - current redsocks.conf does not exist
		}

		// If currentConf is undefined, the currentConf spread will be skipped.
		// See: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-1.html#conditional-spreads-create-optional-properties
		const redsocksConf =
			base() + '\n\n' + redsocks({ ...currentConf, ...conf });
		await writeToBoot(redsocksConfPath, redsocksConf);
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
	return {
		network: {
			proxy: await readProxy(),
			hostname: await readHostname(),
		},
	};
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
			if (conf.network.proxy != null) {
				promises.push(setProxy(conf.network.proxy));
			}
			if (conf.network.hostname != null) {
				promises.push(setHostname(conf.network.hostname));
			}
		}
		await Promise.all(promises);
	});
}
