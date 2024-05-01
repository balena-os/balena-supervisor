import { stripIndent } from 'common-tags';
import _ from 'lodash';
import path from 'path';

import * as applicationManager from './compose/application-manager';
import {
	readHostname,
	setHostname,
	readNoProxy,
	setNoProxy,
} from './host-config/index';
import * as dbus from './lib/dbus';
import { isENOENT } from './lib/errors';
import { mkdirp, unlinkAll } from './lib/fs-utils';
import { writeToBoot, readFromBoot, pathOnBoot } from './lib/host-utils';
import * as updateLock from './lib/update-lock';

const redsocksHeader = stripIndent`
	base {
		log_debug = off;
		log_info = on;
		log = stderr;
		daemon = off;
		redirector = iptables;
	}

	redsocks {
		local_ip = 127.0.0.1;
		local_port = 12345;
`;

const redsocksFooter = '}\n';

const proxyFields = ['type', 'ip', 'port', 'login', 'password'];

const proxyBasePath = pathOnBoot('system-proxy');
const redsocksConfPath = path.join(proxyBasePath, 'redsocks.conf');

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

	const noProxy = await readNoProxy();
	if (noProxy.length) {
		conf.noProxy = noProxy;
	}

	// Convert port to number per API doc spec
	if (conf.port) {
		conf.port = parseInt(conf.port as string, 10);
	}
	return conf;
}

function generateRedsocksConfEntries(conf: ProxyConfig): string {
	let val = '';
	for (const field of proxyFields) {
		let v = conf[field];
		if (v != null) {
			if (isAuthField(field)) {
				// Escape any quotes in the field value
				v = `"${v.toString().replace(/"/g, '\\"')}"`;
			}
			val += `\t${field} = ${v};\n`;
		}
	}
	return val;
}

async function setProxy(maybeConf: ProxyConfig | null): Promise<void> {
	if (_.isEmpty(maybeConf)) {
		await unlinkAll(redsocksConfPath);
		await setNoProxy([]);
	} else {
		// We know that maybeConf is not null due to the _.isEmpty check above,
		// but the compiler doesn't
		const conf = maybeConf as ProxyConfig;
		await mkdirp(proxyBasePath);
		if (Array.isArray(conf.noProxy)) {
			await setNoProxy(conf.noProxy);
		}

		let currentConf: ProxyConfig | undefined;
		try {
			currentConf = await readProxy();
		} catch {
			// Noop - current redsocks.conf does not exist
		}

		// If currentConf is undefined, the currentConf spread will be skipped.
		// See: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-1.html#conditional-spreads-create-optional-properties
		const redsocksConf = `
			${redsocksHeader}\n
			${generateRedsocksConfEntries({ ...currentConf, ...conf })}
			${redsocksFooter}
		`;
		await writeToBoot(redsocksConfPath, redsocksConf);
	}

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
