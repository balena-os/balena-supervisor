import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';
import { exec as execSync } from 'child_process';
import { promisify } from 'util';

import * as constants from './constants';

export const exec = promisify(execSync);

export async function writeAndSyncFile(
	pathName: string,
	data: string | Buffer,
): Promise<void> {
	const file = await fs.open(pathName, 'w');
	if (typeof data === 'string') {
		await file.write(data, 0, 'utf8');
	} else {
		await file.write(data, 0, data.length);
	}
	await file.sync();
	await file.close();
}

export async function writeFileAtomic(
	pathName: string,
	data: string | Buffer,
): Promise<void> {
	await writeAndSyncFile(`${pathName}.new`, data);
	await safeRename(`${pathName}.new`, pathName);
}

export async function safeRename(src: string, dest: string): Promise<void> {
	await fs.rename(src, dest);
	const file = await fs.open(path.dirname(dest), 'r');
	await file.sync();
	await file.close();
}

export async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a path exists as a direct child of the device's root mountpoint,
 * which is equal to constants.rootMountPoint (`/mnt/root`).
 */
export function pathExistsOnHost(pathName: string): Promise<boolean> {
	return exists(path.join(constants.rootMountPoint, pathName));
}

/**
 * Recursively create directories until input directory.
 * Equivalent to mkdirp package, which uses this under the hood.
 */
export async function mkdirp(pathName: string): Promise<void> {
	await fs.mkdir(pathName, { recursive: true });
}

/**
 * Safe unlink with built-in catch for invalid paths, to remove need
 * for catch implementation everywhere else unlink is needed.
 */
export async function unlinkAll(...paths: string[]): Promise<void> {
	await Promise.all(
		paths.map((pathName) =>
			fs.unlink(pathName).catch(() => {
				/* Ignore nonexistent paths */
			}),
		),
	);
}

/**
 * Get one or more paths as they exist in relation to host OS's root.
 */
export function getPathOnHost(...paths: string[]): string[] {
	return paths.map((p: string) => path.join(constants.rootMountPoint, p));
}
