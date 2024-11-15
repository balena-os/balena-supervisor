import { promises as fs } from 'fs';
import os from 'os';
import { dirname } from 'path';

import { exec } from './fs-utils';
import { isENOENT, isEISDIR, isEPERM } from './errors';

// Equivalent to `drwxrwxrwt`
const STICKY_WRITE_PERMISSIONS = 0o1777;

interface LockInfo {
	/**
	 * The lock file path
	 */
	path: string;
	/**
	 * The linux user id (uid) of the
	 * lock
	 */
	owner: number;
}

interface FindAllArgs {
	root: string;
	filter: (lock: LockInfo) => boolean;
	recursive: boolean;
}

// Returns all current locks taken under a directory (default: /tmp)
// Optionally accepts filter function for only getting locks that match a condition.
// A file is counted as a lock by default if it ends with `.lock`.
export async function findAll({
	root = '/tmp',
	filter = (l) => l.path.endsWith('.lock'),
	recursive = true,
}: Partial<FindAllArgs>): Promise<string[]> {
	// Queue of directories to search
	const queue: string[] = [root];
	const locks: string[] = [];

	while (queue.length > 0) {
		root = queue.shift()!;
		try {
			const contents = await fs.readdir(root, { withFileTypes: true });

			for (const file of contents) {
				const path = `${root}/${file.name}`;
				const stats = await fs.lstat(path);

				// A lock is taken if it's a file or directory within root dir that passes filter fn.
				// We also don't want to follow symlinks since we don't want to follow the lock to
				// the target path if it's a symlink and only care that it exists or not.
				if (filter({ path, owner: stats.uid })) {
					locks.push(path);
				} else if (file.isDirectory() && recursive) {
					// Otherwise, if non-lock directory, seek locks recursively within directory
					queue.push(path);
				}
			}
		} catch (err) {
			// if file of directory does not exist continue the search
			// the file, could have been deleted after starting the call
			// to findAll
			if (isENOENT(err)) {
				continue;
			}
			throw err;
		}
	}

	return locks;
}

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
