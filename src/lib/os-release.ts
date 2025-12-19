import memoizee from 'memoizee';
import { promises as fs } from 'fs';

import { InternalInconsistencyError } from './errors';
import log from './supervisor-console';

// Retrieve the data for the OS once only per path
const getOSReleaseData = memoizee(
	async (path: string): Promise<Dictionary<string>> => {
		const releaseItems: Dictionary<string> = {};
		try {
			const releaseData = await fs.readFile(path, 'utf-8');
			const lines = releaseData.split('\n');

			for (const line of lines) {
				const [key, ...values] = line.split('=');

				// Remove enclosing quotes: http://stackoverflow.com/a/19156197/2549019
				const value = values
					.join('=')
					.trim()
					.replace(/^"(.+(?="$))"$/, '$1');
				releaseItems[key.trim()] = value;
			}
		} catch (e: any) {
			throw new InternalInconsistencyError(
				`Unable to read file at ${path}: ${e.message} ${e.stack}`,
			);
		}

		return releaseItems;
	},
	{ promise: true },
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

/**
 * Returns the OS variant information from /etc/os-release
 *
 * OS variants no longer exist and this function only exists for legacy reasons
 *
 * @deprecated
 */
export async function getOSVariant(path: string): Promise<string | undefined> {
	const osVariant = await getOSReleaseField(path, 'VARIANT_ID');
	return osVariant;
}

export function getOSSemver(path: string): Promise<string | undefined> {
	return getOSReleaseField(path, 'VERSION');
}

export function getOSBoardRev(path: string): Promise<string | undefined> {
	return getOSReleaseField(path, 'BALENA_BOARD_REV');
}

export async function getMetaOSRelease(
	path: string,
): Promise<string | undefined> {
	return getOSReleaseField(path, 'META_BALENA_VERSION');
}

export async function getOSSlug(path: string): Promise<string | undefined> {
	return getOSReleaseField(path, 'ID');
}
