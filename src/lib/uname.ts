import { TypedError } from 'typed-error';
import { exec } from './fs-utils';
import log from './supervisor-console';

export class UnameError extends TypedError {}

// Exported for tests
export async function get(flags = ''): Promise<string> {
	const { stdout, stderr } = await exec(`uname${flags ? ` ${flags}` : ''}`);
	if (stderr.length > 0) {
		throw new UnameError(`Error querying uname: ${stderr}`);
	}
	return stdout.toString().trim();
}

export async function getKernelSlug(): Promise<string | undefined> {
	try {
		// `exports` makes `get` mockable for testing.
		const uname = await exports.get('-s');
		return uname.toLowerCase();
	} catch (e) {
		// Realistically, this shouldn't happen, but the exec to `uname` could fail,
		// and we don't want to crash the Supervisor if so.
		log.error(`Could not detect kernel slug! Error: ${(e as Error).message}`);
		return;
	}
}

const KERNEL_VERSION_REGEX = /^(\d+\.\d+\.\d+)/;
export async function getKernelVersion(): Promise<string | undefined> {
	try {
		// `exports` makes `get` mockable for testing.
		const uname = await exports.get('-r');
		const match = KERNEL_VERSION_REGEX.exec(uname);
		return match?.[1];
	} catch (e) {
		// Realistically, this shouldn't happen, but the exec to `uname` could fail,
		// and we don't want to crash the Supervisor if so.
		log.error(
			`Could not detect kernel version! Error: ${(e as Error).message}`,
		);
		return;
	}
}

const L4T_REGEX = /^.*-l4t-r(\d+\.\d+(\.?\d+)?).*$/;
export async function getL4tVersion(): Promise<string | undefined> {
	// We call `uname -r` on the host, and look for l4t
	try {
		// `exports` makes `get` mockable for testing.
		const uname = await exports.get('-r');
		const match = L4T_REGEX.exec(uname);
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
		// Realistically, this shouldn't happen, but the exec to `uname` could fail,
		// and we don't want to crash the Supervisor if so.
		log.error(`Could not detect l4t version! Error: ${(e as Error).message}`);
		return;
	}
}
