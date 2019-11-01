import * as _ from 'lodash';
import fs = require('mz/fs');

import { InternalInconsistencyError } from './errors';
import log from './supervisor-console';

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
		if (value == null) {
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
	return getOSReleaseField(path, 'VARIANT_ID');
}

export function getOSSemver(path: string): Promise<string | undefined> {
	return getOSReleaseField(path, 'VERSION');
}
