import * as path from 'path';
import * as constants from './constants';
import * as fsUtils from './fs-utils';

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

// Receives an absolute path for a file under the boot partition (e.g. `/mnt/root/mnt/boot/config.txt`)
// and writes the given data. This function uses the best effort to write a file trying to minimize corruption
// due to a power cut. Given that the boot partition is a vfat filesystem, this means
// using write + sync
export async function writeToBoot(file: string, data: string | Buffer) {
	return await fsUtils.writeAndSyncFile(file, data);
}
