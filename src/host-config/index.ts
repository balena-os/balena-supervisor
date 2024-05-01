import { promises as fs } from 'fs';

import type { RedsocksConfig, ProxyConfig } from './types';
import * as config from '../config';
import { pathOnRoot } from '../lib/host-utils';

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
