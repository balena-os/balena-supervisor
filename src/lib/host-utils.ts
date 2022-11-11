import { spawn } from 'child_process';
import * as path from 'path';
import * as constants from './constants';
import { exec } from './fs-utils';

// Returns an absolute path starting from the hostOS root partition
// This path is accessible from within the Supervisor container
export function pathOnRoot(relPath: string) {
	return path.join(constants.rootMountPoint, relPath);
}

// Returns an absolute path starting from the hostOS boot partition
// This path is accessible from within the Supervisor container
export function pathOnBoot(relPath: string) {
	return pathOnRoot(path.join(constants.bootMountPoint, relPath));
}

class CodedError extends Error {
	constructor(msg: string, readonly code: number) {
		super(msg);
	}
}

// Receives an absolute path for a file (assumed to be under the boot partition, e.g. `/mnt/root/mnt/boot/config.txt`)
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
	const cmd = ['fatrw', 'read', fileName].join(' ');
	const { stdout } = await exec(cmd, {
		encoding,
	});
	return stdout;
}

// Receives an absolute path for a file (assumed to be under the boot partition, e.g. `/mnt/root/mnt/boot/config.txt`)
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

	if (exitCode) {
		throw new CodedError(`Write failed with error: ${error}`, exitCode);
	}
}
