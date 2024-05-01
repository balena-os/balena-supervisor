import { promises as fs } from 'fs';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import type { RedsocksConfig, ProxyConfig } from './types';
import { HostConfiguration, LegacyHostConfiguration } from './types';
import * as config from '../config';
import { pathOnRoot } from '../lib/host-utils';
import log from '../lib/supervisor-console';

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
): HostConfiguration | LegacyHostConfiguration | null {
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
	return null;
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
