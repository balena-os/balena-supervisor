import { promises as fs } from 'fs';
import type { Stats, Dirent } from 'fs';
import os from 'os';
import { dirname } from 'path';

import { exec } from './fs-utils';
import { isENOENT, isEISDIR, isEPERM } from './errors';

// Equivalent to `drwxrwxrwt`
const STICKY_WRITE_PERMISSIONS = 0o1777;

// Returns all current locks taken under a directory (default: /tmp)
// Optionally accepts filter function for only getting locks that match a condition.
// A file is counted as a lock by default if it ends with `.lock`.
export const getLocksTaken = async (
	rootDir: string = '/tmp',
	lockFilter: (path: string, stat: Stats) => boolean = (p) =>
		p.endsWith('.lock'),
): Promise<string[]> => {
	const locksTaken: string[] = [];
	let filesOrDirs: Dirent[] = [];
	try {
		filesOrDirs = await fs.readdir(rootDir, { withFileTypes: true });
	} catch (err) {
		// If lockfile directory doesn't exist, no locks are taken
		if (isENOENT(err)) {
			return locksTaken;
		}
	}
	for (const fileOrDir of filesOrDirs) {
		const lockPath = `${rootDir}/${fileOrDir.name}`;
		// A lock is taken if it's a file or directory within rootDir that passes filter fn
		if (lockFilter(lockPath, await fs.stat(lockPath))) {
			locksTaken.push(lockPath);
			// Otherwise, if non-lock directory, seek locks recursively within directory
		} else if (fileOrDir.isDirectory()) {
			locksTaken.push(...(await getLocksTaken(lockPath, lockFilter)));
		}
	}
	return locksTaken;
};

interface ChildProcessError {
	code: number;
	stderr: string;
	stdout: string;
}

export class LockfileExistsError implements ChildProcessError {
	public code: number;
	public stderr: string;
	public stdout: string;

	constructor(path: string) {
		this.code = 73;
		this.stderr = `lockfile: Sorry, giving up on "${path}"`;
		this.stdout = '';
	}

	// Check if an error is an instance of LockfileExistsError.
	// This is necessary because the error thrown is a child process
	// error that isn't typed by default, so instanceof will not work.
	public static is(error: unknown): error is LockfileExistsError {
		return (error as LockfileExistsError).code === 73;
	}
}

export async function lock(path: string, uid: number = os.userInfo().uid) {
	/**
	 * Set parent directory permissions to `drwxrwxrwt` (octal 1777), which are needed
	 * for lockfile binary to run successfully as the any non-root uid, if executing
	 * this command as a privileged uid.
	 * NOTE: This will change the permissions of the parent directory at `path`,
	 * which may not be expected if using lockfile as an independent module.
	 *
	 * `chmod` does not fail or throw if the directory already has the proper permissions.
	 */
	if (uid !== 0) {
		await fs.chmod(dirname(path), STICKY_WRITE_PERMISSIONS);
	}

	/**
	 * Run the lockfile binary as the provided UID. See https://linux.die.net/man/1/lockfile
	 * `-r 0` means that lockfile will not retry if the lock exists.
	 * If `uid` is not privileged or does not have write permissions to the path, this command will not succeed.
	 */
	try {
		// Lock the file using binary
		await exec(`lockfile -r 0 ${path}`, { uid });
	} catch (error) {
		// Code 73 refers to EX_CANTCREAT (73) in sysexits.h, or:
		// A (user specified) output file cannot be created.
		// See: https://nxmnpg.lemoda.net/3/sysexits
		if (LockfileExistsError.is(error)) {
			// If error code is 73, updates.lock file already exists, so throw this error directly
			throw error;
		} else {
			/**
			 * For the most part, a child process error with code 73 should be thrown,
			 * indicating the lockfile already exists. Any other error's child process
			 * code should be included in the error message to more clearly signal
			 * what went wrong. Other errors that are not the typical "file exists"
			 * errors include but aren't limited to:
			 *   - running out of file descriptors
			 *   - binary corruption
			 *   - other systems-based errors
			 */
			throw new Error(
				`Got code ${
					(error as ChildProcessError).code
				} while trying to take lock: ${(error as ChildProcessError).stderr}`,
			);
		}
	}
}

export async function unlock(path: string): Promise<void> {
	// Removing the lockfile releases the lock
	await fs.unlink(path).catch((e) => {
		// if the error is EPERM|EISDIR, the file is a directory
		if (isEPERM(e) || isEISDIR(e)) {
			return fs.rmdir(path).catch(() => {
				// if the directory is not empty or something else
				// happens, ignore
			});
		}
		// If the file does not exist or some other error
		// happens, then ignore the error
	});
}
