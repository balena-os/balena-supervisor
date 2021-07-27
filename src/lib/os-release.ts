import * as _ from 'lodash';
import { promises as fs } from 'fs';

import { InternalInconsistencyError } from './errors';
import { exec } from './fs-utils';
import log from './supervisor-console';
import * as conf from '../config';

// Retrieve the data for the OS once only per path
const getOSReleaseData = _.memoize(
	async (path: string): Promise<Dictionary<string>> => {
		const releaseItems: Dictionary<string> = {};
		try {
			const releaseData = await fs.readFile(path, 'utf-8');
			const lines = releaseData.split('\n');

			for (const line of lines) {
				const [key, ...values] = line.split('=');

				// Remove enclosing quotes: http://stackoverflow.com/a/19156197/2549019
				const value = _.trim(values.join('=')).replace(/^"(.+(?="$))"$/, '$1');
				releaseItems[_.trim(key)] = value;
			}
		} catch (e) {
			throw new InternalInconsistencyError(
				`Unable to read file at ${path}: ${e.message} ${e.stack}`,
			);
		}

		return releaseItems;
	},
);

async function getOSReleaseField(
	path: string,
	field: string,
): Promise<string | undefined> {
	try {
		const data = await getOSReleaseData(path);
		const value = data[field];
		if (value == null && field !== 'VARIANT_ID') {
			log.warn(
				`Field ${field} is not available in OS information file: ${path}`,
			);
		}
		return data[field];
	} catch (e) {
		log.warn('Unable to read OS version information: ', e);
	}
}

export async function getOSVersion(path: string): Promise<string | undefined> {
	return getOSReleaseField(path, 'PRETTY_NAME');
}

export async function getOSVariant(path: string): Promise<string | undefined> {
	const osVariant = await getOSReleaseField(path, 'VARIANT_ID');
	if (osVariant === undefined) {
		const developmentMode = await conf.get('developmentMode');
		return developmentMode === true ? 'dev' : 'prod';
	}
	return osVariant;
}

export function getOSSemver(path: string): Promise<string | undefined> {
	return getOSReleaseField(path, 'VERSION');
}

export async function getMetaOSRelease(
	path: string,
): Promise<string | undefined> {
	return getOSReleaseField(path, 'META_BALENA_VERSION');
}

const L4T_REGEX = /^.*-l4t-r(\d+\.\d+(\.?\d+)?).*$/;
export async function getL4tVersion(): Promise<string | undefined> {
	// We call `uname -r` on the host, and look for l4t
	try {
		const { stdout } = await exec('uname -r');
		const match = L4T_REGEX.exec(stdout.toString().trim());
		if (match == null) {
			return;
		}

		let res = match[1];
		if (match[2] == null) {
			// We were only provided with 2 version numbers
			// We add a .0 onto the end, to allow always being
			// able to use semver comparisons
			res += '.0';
		}

		return res;
	} catch (e) {
		log.error('Could not detect l4t version! Error: ', e);
		return;
	}
}
