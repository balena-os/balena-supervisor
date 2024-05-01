import { promises as fs } from 'fs';

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
