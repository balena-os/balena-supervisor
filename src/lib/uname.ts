import { TypedError } from 'typed-error';
import { exec } from './fs-utils';

export class UnameError extends TypedError {}

// Exported for tests
export async function get(flags = ''): Promise<string> {
	const { stdout, stderr } = await exec(`uname${flags ? ` ${flags}` : ''}`);
	if (stderr.length > 0) {
		throw new UnameError(`Error querying uname: ${stderr}`);
	}
	return stdout.toString().trim();
}

export function parseKernelSlug(slug: string): string {
	return slug.toLowerCase();
}

const KERNEL_VERSION_REGEX = /^(\d+\.\d+\.\d+)/;
export function parseKernelVersion(version: string): string | undefined {
	const match = KERNEL_VERSION_REGEX.exec(version);
	return match?.[1];
}

const L4T_REGEX = /^.*-l4t-r(\d+\.\d+(\.?\d+)?).*$/;
export function parseL4tVersion(version: string): string | undefined {
	const match = L4T_REGEX.exec(version);
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
}
