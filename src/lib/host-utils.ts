import { spawn } from 'child_process';
import path from 'path';
import * as constants from './constants';
import { exec, exists } from './fs-utils';

function withBase(base: string) {
	function withPath(): string;
	function withPath(singlePath: string): string;
	function withPath(...paths: string[]): string[];
	function withPath(...paths: string[]): string[] | string {
		if (arguments.length === 0) {
			return base;
		} else if (paths.length === 1) {
			return path.join(base, paths[0]);
		} else {
			return paths.map((p: string) => path.join(base, p));
		}
	}
	return withPath;
}

// Returns an absolute path starting from the hostOS root partition
// This path is accessible from within the Supervisor container
export const pathOnRoot = withBase(constants.rootMountPoint);

export const pathExistsOnRoot = async (p: string) =>
	await exists(pathOnRoot(p));

// Returns an absolute path starting from the hostOS boot partition
// This path is accessible from within the Supervisor container
export const pathOnBoot = withBase(constants.bootMountPoint);

// Returns an absolute path starting from the hostOS data partition
// This path is accessible from within the Supervisor container
export const pathOnData = withBase(constants.dataMountPoint);

// Returns an absolute path starting from the hostOS state partition
// This path is accessible from within the Supervisor container
export const pathOnState = withBase(constants.stateMountPoint);

export const pathExistsOnState = async (p: string) =>
	await exists(pathOnState(p));

class CodedError extends Error {
	constructor(
		msg: string,
		readonly code: number | string,
	) {
		super(msg);
	}
}

// Receives an absolute path for a file (assumed to be under the boot partition, e.g. `/mnt/boot/config.txt`)
// and reads from the given location. This function uses fatrw to safely read from a FAT filesystem
// https://github.com/balena-os/fatrw
export async function readFromBoot(
	fileName: string,
	encoding: 'utf-8' | 'utf8',
): Promise<string>;
export async function readFromBoot(fileName: string): Promise<Buffer>;
export async function readFromBoot(
	fileName: string,
	encoding?: 'utf8' | 'utf-8',
): Promise<string | Buffer> {
	if (!(await exists(fileName))) {
		// Mimic the behavior of Node readFile
		throw new CodedError(`Failed to read file ${fileName}`, 'ENOENT');
	}

	const cmd = ['fatrw', 'read', fileName].join(' ');

	try {
		const { stdout } = await exec(cmd, {
			encoding,
		});
		return stdout;
	} catch (e: any) {
		const { code, stderr } = e;
		throw new CodedError(stderr ?? e.message, code);
	}
}

// Receives an absolute path for a file (assumed to be under the boot partition,
// e.g. `/mnt/boot/config.txt` or legacy `/mnt/root/mnt/boot/config.txt`)
// and writes the given data. This function uses fatrw to safely write from a FAT filesystem
// https://github.com/balena-os/fatrw
export async function writeToBoot(fileName: string, data: string | Buffer) {
	const fatrw = spawn('fatrw', ['write', fileName], { stdio: 'pipe' });

	// Write to the process stdinput
	fatrw.stdin.write(data);
	fatrw.stdin.end();

	// We only care about stderr
	let error = '';
	for await (const chunk of fatrw.stderr) {
		error += chunk;
	}
	const exitCode: number = await new Promise((resolve) => {
		fatrw.on('close', resolve);
	});

	if (exitCode !== 0) {
		throw new CodedError(`Write failed with error: ${error}`, exitCode);
	}
}
