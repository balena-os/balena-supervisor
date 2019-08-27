import * as fs from 'fs';
import * as _ from 'lodash';

import log from './supervisor-console';

// FIXME: Don't use synchronous file reading and change call sites to support a promise
function getOSReleaseField(path: string, field: string): string | undefined {
	try {
		const releaseData = fs.readFileSync(path, 'utf-8');
		const lines = releaseData.split('\n');
		const releaseItems: { [field: string]: string } = {};

		for (const line of lines) {
			const [key, value] = line.split('=');
			releaseItems[_.trim(key)] = _.trim(value);
		}

		if (releaseItems[field] == null) {
			throw new Error(`Field ${field} not available in ${path}`);
		}

		// Remove enclosing quotes: http://stackoverflow.com/a/19156197/2549019
		return releaseItems[field].replace(/^"(.+(?="$))"$/, '$1');
	} catch (err) {
		log.error('Could not get OS release field: ', err);
		return;
	}
}

export function getOSVersionSync(path: string): string | undefined {
	return getOSReleaseField(path, 'PRETTY_NAME');
}

export function getOSVersion(path: string): Bluebird<string | undefined> {
	return Bluebird.try(() => {
		return getOSVersionSync(path);
	});
}

export function getOSVariantSync(path: string): string | undefined {
	return getOSReleaseField(path, 'VARIANT_ID');
}

export function getOSVariant(path: string): Bluebird<string | undefined> {
	return Bluebird.try(() => {
		return getOSVariantSync(path);
	});
}
