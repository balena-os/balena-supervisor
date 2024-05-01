import { promises as fs } from 'fs';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import type { RedsocksConfig, ProxyConfig } from './types';
import { HostConfiguration, LegacyHostConfiguration } from './types';
import { readProxy, setProxy } from './proxy';
import * as config from '../config';
// FIXME: The host-config module shouldn't be importing from compose
import * as applicationManager from '../compose/application-manager';
import { pathOnRoot } from '../lib/host-utils';
import log from '../lib/supervisor-console';
import * as updateLock from '../lib/update-lock';

export * from './proxy';
export * from './types';

const hostnamePath = pathOnRoot('/etc/hostname');

export async function readHostname() {
	const hostnameData = await fs.readFile(hostnamePath, 'utf-8');
	return hostnameData.trim();
}

export async function setHostname(val: string) {
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

export function patchProxy(
	currentConf: RedsocksConfig,
	inputConf: Partial<{
		redsocks: Partial<ProxyConfig>;
	}>,
): RedsocksConfig {
	const patchedConf: RedsocksConfig = {};

	// If input is empty, redsocks config should be removed
	if (!inputConf || Object.keys(inputConf).length === 0) {
		return patchedConf;
	}

	if (inputConf.redsocks && Object.keys(inputConf.redsocks).length > 0) {
		// This method assumes that currentConf is a full ProxyConfig
		// for backwards compatibility, so patchedConf.redsocks should
		// also be a full ProxyConfig.
		const patched = {
			...currentConf.redsocks,
			...inputConf.redsocks,
		} as Record<string, any>;
		patchedConf.redsocks = patched as ProxyConfig;
	}
	return patchedConf;
}

export async function patch(
	conf: HostConfiguration | LegacyHostConfiguration,
	force: boolean = false,
): Promise<void> {
	const apps = await applicationManager.getCurrentApps();
	const appIds = Object.keys(apps).map((strId) => parseInt(strId, 10));

	if (conf.network.hostname != null) {
		await setHostname(conf.network.hostname);
	}

	if (conf.network.proxy != null) {
		const targetConf = conf.network.proxy;
		// It's possible for appIds to be an empty array, but patch shouldn't fail
		// as it's not dependent on there being any running user applications.
		return updateLock.lock(appIds, { force }, async () => {
			const proxyConf = await readProxy();
			let currentConf: ProxyConfig | undefined = undefined;
			if (proxyConf) {
				delete proxyConf.noProxy;
				currentConf = proxyConf;
			}

			// Merge current & target redsocks.conf
			const patchedConf = patchProxy(
				{
					redsocks: currentConf,
				},
				{
					redsocks: targetConf,
				},
			);
			await setProxy(patchedConf, targetConf.noProxy);
		});
	}
}

export async function get(): Promise<HostConfiguration> {
	return {
		network: {
			hostname: await readHostname(),
			proxy: await readProxy(),
		},
	};
}
