import { promises as fs } from 'fs';
import path from 'path';

import { pathOnBoot, readFromBoot } from '../lib/host-utils';
import { unlinkAll } from '../lib/fs-utils';
import { isENOENT } from '../lib/errors';

const proxyBasePath = pathOnBoot('system-proxy');
const noProxyPath = path.join(proxyBasePath, 'no_proxy');

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
