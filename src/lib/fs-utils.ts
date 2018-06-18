import * as Bluebird from 'bluebird';
import { fs } from 'mz';
import * as path from 'path';

export function writeAndSyncFile(path: string, data: string): Bluebird<void> {
	return Bluebird.resolve(fs.open(path, 'w'))
		.then((fd) => {
			fs.write(fd, data, 0, 'utf8')
				.then(() => fs.fsync(fd))
				.then(() => fs.close(fd));
		});
}

export function writeFileAtomic(path: string, data: string): Bluebird<void> {
	return Bluebird.resolve(writeAndSyncFile(`${path}.new`, data))
		.then(() => fs.rename(`${path}.new`, path));
}

export function safeRename(src: string, dest: string): Bluebird<void> {
	return Bluebird.resolve(fs.rename(src, dest))
		.then(() => fs.open(path.dirname(dest), 'r'))
		.tap(fs.fsync)
		.then(fs.close);
}
